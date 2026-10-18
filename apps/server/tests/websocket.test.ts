import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

const MESSAGE_SYNC = 0;
const MESSAGE_FLUSH_REQUEST = 2;
const MESSAGE_FLUSH_ACK = 3;

 describe('collaboration WebSocket', () => {
  it('orders edits, flush acknowledgement, agent replacement, and compilation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overroot-websocket-'));
    config.fakeCompiler = true;
    const { app, context } = await buildApp({ databasePath: join(dir, 'state.sqlite3'), logger: false });
    try {
      await context.auth.createUser('editor', 'editor-password-123', true);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'editor', password: 'editor-password-123' } });
      const token = login.json().token as string;
      const headers = { authorization: `Bearer ${token}` };
      const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Live paper', template: 'article' } });
      const hash = created.json().project.hash as string;
      const tree = await app.inject({ method: 'GET', url: `/api/v1/projects/${hash}/files`, headers });
      const main = tree.json().files.find((file: any) => file.path === 'main.tex');

      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const ticketResponse = await app.inject({
        method: 'POST', url: '/api/v1/ws-ticket', headers,
        payload: { projectHash: hash, channel: 'file', fileId: main.id }
      });
      const ticket = ticketResponse.json();
      const client = new YClient(`ws://127.0.0.1:${port}${ticket.path}?ticket=${encodeURIComponent(ticket.ticket)}`);
      await client.synced;
      expect(client.text.toString()).toContain('Untitled article');

      client.text.insert(client.text.length, '\n% written over WebSocket\n');
      await client.flush();
      const afterHuman = await app.inject({ method: 'GET', url: `/api/v1/projects/${hash}/files/${main.id}`, headers });
      expect(afterHuman.json().file.content).toContain('written over WebSocket');

      const credential = await app.inject({ method: 'POST', url: `/api/v1/projects/${hash}/agents`, headers, payload: { name: 'Direct agent' } });
      const agentPassword = credential.json().access.password as string;
      const replacement = `${afterHuman.json().file.content}\n% written by agent\n`;
      const agentWrite = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${hash}/files/${main.id}`,
        headers: { authorization: `Bearer ${agentPassword}`, 'if-match': afterHuman.json().file.revision },
        payload: { content: replacement }
      });
      expect(agentWrite.statusCode).toBe(200);
      await waitUntil(() => client.text.toString().includes('written by agent'));

      const compile = await app.inject({ method: 'POST', url: `/api/v1/projects/${hash}/compile`, headers });
      expect([200, 202]).toContain(compile.statusCode);
      const jobId = compile.json().job.id as string;
      await waitUntil(() => context.compiler.get(jobId, context.projects.getProjectByHash(hash)!.id)?.status === 'succeeded');
      client.close();
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

class YClient {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText('content');
  readonly synced: Promise<void>;
  private readonly socket: WebSocket;
  private resolveSynced!: () => void;
  private nextFlush = 1;
  private readonly flushes = new Map<number, () => void>();

  constructor(url: string) {
    this.synced = new Promise((resolve) => { this.resolveSynced = resolve; });
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_SYNC);
      syncProtocol.writeUpdate(message, update);
      this.socket.send(encoding.toUint8Array(message));
    });
    this.socket.on('open', () => {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(message, this.doc);
      this.socket.send(encoding.toUint8Array(message));
    });
    this.socket.on('message', (raw) => {
      const decoder = decoding.createDecoder(new Uint8Array(raw as ArrayBuffer));
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const syncType = decoding.peekVarUint(decoder);
        const response = encoding.createEncoder();
        encoding.writeVarUint(response, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, response, this.doc, this.socket);
        if (encoding.length(response) > 1) this.socket.send(encoding.toUint8Array(response));
        if (syncType === syncProtocol.messageYjsSyncStep2) this.resolveSynced();
      } else if (type === MESSAGE_FLUSH_ACK) {
        const id = decoding.readVarUint(decoder);
        this.flushes.get(id)?.();
        this.flushes.delete(id);
      }
    });
  }

  flush(): Promise<void> {
    const id = this.nextFlush++;
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_FLUSH_REQUEST);
    encoding.writeVarUint(message, id);
    return new Promise((resolve) => {
      this.flushes.set(id, resolve);
      this.socket.send(encoding.toUint8Array(message));
    });
  }

  close(): void {
    this.socket.close();
    this.doc.destroy();
  }
}

async function waitUntil(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Condition was not met before timeout');
}
