import type { AuthService } from './auth.js';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CollaborationManager, EventHub } from './collaboration.js';
import { config } from './config.js';
import { randomToken } from './security.js';
import type { ActorIdentity } from './types.js';

export type TicketChannel = 'file' | 'events';

export interface WebSocketTicket {
  token: string;
  channel: TicketChannel;
  projectId: string;
  projectHash: string;
  fileId?: string;
  actor: ActorIdentity;
  sessionHash: string;
  expiresAt: number;
}

export class TicketStore {
  private readonly tickets = new Map<string, WebSocketTicket>();

  create(input: Omit<WebSocketTicket, 'token' | 'expiresAt'>): WebSocketTicket {
    this.cleanup();
    const ticket: WebSocketTicket = {
      ...input,
      token: randomToken('ul_ws_', 24),
      expiresAt: Date.now() + 30_000
    };
    this.tickets.set(ticket.token, ticket);
    return ticket;
  }

  consume(token: string): WebSocketTicket | null {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.expiresAt < Date.now()) return null;
    return ticket;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(token);
    }
  }
}

export class WebSocketGateway {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  private stopping = false;
  private readonly checks = new Set<Promise<boolean>>();
  private readonly timers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private readonly active = new Map<WebSocket, WebSocketTicket>();

  constructor(
    httpServer: HttpServer,
    private readonly tickets: TicketStore,
    private readonly collaboration: CollaborationManager,
    private readonly events: EventHub,
    private readonly auth: AuthService
  ) {
    httpServer.on('upgrade', (request, socket, head) => { void this.upgrade(request, socket, head); });
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.active.keys()) socket.close(1001, 'Server stopping');
    await Promise.allSettled([...this.checks]);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  closeSession(sessionHash: string): void {
    this.closeMatching((ticket) => ticket.sessionHash === sessionHash, 'Session ended');
  }

  closeOtherUserSessions(userId: string, exceptSessionHash: string): void {
    this.closeMatching(
      (ticket) => ticket.actor.type === 'user' && ticket.actor.id === userId && ticket.sessionHash !== exceptSessionHash,
      'Session ended'
    );
  }

  closeUserProject(userId: string, projectId: string): void {
    this.closeMatching(
      (ticket) => ticket.actor.type === 'user' && ticket.actor.id === userId && ticket.projectId === projectId,
      'Project access changed'
    );
  }

  closeProject(projectId: string): void {
    this.closeMatching((ticket) => ticket.projectId === projectId, 'Project removed');
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      if (this.stopping) return reject(socket, 503, 'Server stopping');
      if (request.headers.host !== new URL(config.publicUrl).host) return reject(socket, 403, 'Host denied');
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) return reject(socket, 403, 'Origin denied');
      const url = new URL(request.url ?? '/', 'http://overroot.local');
      if (!url.pathname.startsWith('/ws/')) return;
      const ticket = this.tickets.consume(url.searchParams.get('ticket') ?? '');
      if (!ticket) return reject(socket, 401, 'Invalid ticket');

      const fileMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/files\/([^/]+)$/);
      const eventsMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/events$/);
      if (ticket.channel === 'file') {
        if (!fileMatch || decodeURIComponent(fileMatch[1]!) !== ticket.projectHash || decodeURIComponent(fileMatch[2]!) !== ticket.fileId) {
          return reject(socket, 403, 'Ticket scope mismatch');
        }
      } else if (!eventsMatch || decodeURIComponent(eventsMatch[1]!) !== ticket.projectHash) {
        return reject(socket, 403, 'Ticket scope mismatch');
      }

      if (ticket.actor.type === 'user') {
        if (origin !== config.publicUrl) return reject(socket, 403, 'Origin denied');
        try {
          if (!await this.validate(ticket)) return reject(socket, 401, 'Session ended');
        } catch { return reject(socket, 503, 'Accounts unavailable'); }
      }
      if (this.stopping || socket.destroyed) return reject(socket, 503, 'Server stopping');
      this.server.handleUpgrade(request, socket, head, (websocket) => this.connected(websocket, ticket));
    } catch {
      reject(socket, 400, 'Invalid WebSocket request');
    }
  }

  private connected(socket: WebSocket, ticket: WebSocketTicket): void {
    this.active.set(socket, ticket);
    socket.once('close', () => {
      this.active.delete(socket);
      clearTimeout(this.timers.get(socket));
      this.timers.delete(socket);
    });
    if (ticket.actor.type === 'user') this.scheduleValidation(socket, ticket);
    if (ticket.channel === 'file' && ticket.fileId) {
      this.collaboration.connect(socket, ticket.fileId, ticket.actor);
    } else {
      this.events.add(ticket.projectId, socket);
    }
  }

  private async validate(ticket: WebSocketTicket): Promise<boolean> {
    const check = this.auth.validateSocket(ticket);
    this.checks.add(check);
    try { return await check; }
    finally { this.checks.delete(check); }
  }

  private scheduleValidation(socket: WebSocket, ticket: WebSocketTicket): void {
    if (this.stopping || !this.active.has(socket) || socket.readyState !== 1) return;
    const timer = setTimeout(() => {
      this.timers.delete(socket);
      void this.validate(ticket).then((actor) => {
        if (!actor) socket.close(1008, 'Session ended');
        else this.scheduleValidation(socket, ticket);
      }).catch(() => { socket.close(1013, 'Accounts unavailable. Reconnect shortly.'); });
    }, 10_000);
    timer.unref();
    this.timers.set(socket, timer);
  }

  private closeMatching(predicate: (ticket: WebSocketTicket) => boolean, reason: string): void {
    for (const [socket, ticket] of this.active) {
      if (predicate(ticket)) socket.close(1008, reason);
    }
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
