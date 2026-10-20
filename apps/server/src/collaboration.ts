import type { RawData, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { simpleDiffString } from 'lib0/diff';
import type { ProjectStore } from './project-store.js';
import { fileRevision, revisionHash } from './security.js';
import type { ActorIdentity, FileRecord } from './types.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_FLUSH_REQUEST = 2;
const MESSAGE_FLUSH_ACK = 3;
const PERSIST_DELAY_MS = 500;

interface CollabSocket extends WebSocket {
  controlledAwarenessIds?: Set<number>;
  actor?: ActorIdentity;
}

interface ActiveFile {
  fileId: string;
  projectId: string;
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  clients: Set<CollabSocket>;
  persistTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  lastActor: ActorIdentity;
  persistedRevision: string;
  persistedYStateHash: string;
  disposed: boolean;
}

export interface ProjectEvent {
  type: string;
  projectHash?: string;
  [key: string]: unknown;
}

export class EventHub {
  private readonly clients = new Map<string, Set<WebSocket>>();

  add(projectId: string, socket: WebSocket): void {
    const set = this.clients.get(projectId) ?? new Set<WebSocket>();
    set.add(socket);
    this.clients.set(projectId, set);
    socket.on('close', () => {
      set.delete(socket);
      if (set.size === 0) this.clients.delete(projectId);
    });
    this.send(socket, { type: 'connected' });
  }

  emit(projectId: string, event: ProjectEvent): void {
    const message = JSON.stringify({ ...event, at: new Date().toISOString() });
    for (const socket of this.clients.get(projectId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  close(): void {
    for (const sockets of this.clients.values()) {
      for (const socket of sockets) socket.close(1001, 'Server stopping');
    }
    this.clients.clear();
  }

  private send(socket: WebSocket, event: ProjectEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ ...event, at: new Date().toISOString() }));
  }
}

export class CollaborationManager {
  private readonly active = new Map<string, ActiveFile>();

  constructor(
    private readonly store: ProjectStore,
    readonly events: EventHub
  ) {}

  connect(socketInput: WebSocket, fileId: string, actor: ActorIdentity): void {
    const socket = socketInput as CollabSocket;
    const active = this.getOrCreate(fileId);
    if (active.idleTimer) {
      clearTimeout(active.idleTimer);
      active.idleTimer = undefined;
    }
    socket.actor = actor;
    socket.controlledAwarenessIds = new Set();
    active.clients.add(socket);

    socket.on('message', (data: RawData) => {
      if (socket.readyState === socket.OPEN) this.onMessage(active, socket, data);
    });
    socket.on('close', () => {
      active.clients.delete(socket);
      const ids = [...(socket.controlledAwarenessIds ?? [])];
      if (ids.length) awarenessProtocol.removeAwarenessStates(active.awareness, ids, socket);
      if (active.clients.size === 0 && !active.disposed) this.scheduleEviction(active);
    });
    socket.on('error', () => socket.close());

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, active.doc);
    socket.send(encoding.toUint8Array(encoder));

    const states = [...active.awareness.getStates().keys()];
    if (states.length) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(active.awareness, states)
      );
      socket.send(encoding.toUint8Array(awarenessEncoder));
    }
  }

  current(fileId: string): { file: FileRecord; content: Uint8Array; revision: string } {
    const file = this.store.getFileById(fileId);
    if (!file) throw new Error('File not found');
    const active = this.active.get(fileId);
    if (!active || file.kind !== 'text') {
      const content = Buffer.from(file.content);
      return { file, content, revision: file.revision_hash };
    }
    const content = Buffer.from(active.text.toString());
    return { file, content, revision: fileRevision(file.path, content) };
  }

  async replaceText(fileId: string, content: string, actor: ActorIdentity): Promise<FileRecord> {
    const active = this.getOrCreate(fileId);
    // Preserve a pending collaborator revision before attributing the replacement to another actor.
    await this.flush(active);
    active.lastActor = actor;
    // Keep unchanged prefix/suffix character identities alive so a REST save
    // does not invalidate a connected human's undo history and cursor anchors.
    const change = simpleDiffString(active.text.toString(), content);
    active.doc.transact(() => {
      active.text.delete(change.index, change.remove);
      active.text.insert(change.index, change.insert);
    }, { overroot: true, actor });
    const saved = await this.flush(active, true);
    if (active.clients.size === 0) this.scheduleEviction(active);
    return saved;
  }

  async flushProject(projectId: string): Promise<void> {
    await Promise.all([...this.active.values()].filter((file) => file.projectId === projectId).map((file) => this.flush(file)));
  }

  async remove(fileId: string): Promise<void> {
    const active = this.active.get(fileId);
    if (!active) return;
    await this.flush(active);
    active.disposed = true;
    if (active.persistTimer) clearTimeout(active.persistTimer);
    if (active.idleTimer) clearTimeout(active.idleTimer);
    this.active.delete(fileId);
    for (const socket of active.clients) socket.close(1000, 'File removed');
    active.awareness.destroy();
    active.doc.destroy();
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map((file) => this.flush(file)));
    for (const file of this.active.values()) {
      file.disposed = true;
      for (const socket of file.clients) socket.close(1001, 'Server stopping');
      file.awareness.destroy();
      file.doc.destroy();
    }
    this.active.clear();
    this.events.close();
  }

  private getOrCreate(fileId: string): ActiveFile {
    const existing = this.active.get(fileId);
    if (existing) return existing;
    const file = this.store.getFileById(fileId);
    if (!file || file.kind !== 'text') throw new Error('Collaborative file not found');
    const doc = new Y.Doc();
    const text = doc.getText('content');
    if (file.y_state) Y.applyUpdate(doc, file.y_state);
    else {
      text.insert(0, Buffer.from(file.content).toString('utf8'));
      this.store.saveYState(file.id, Y.encodeStateAsUpdate(doc));
    }
    const awareness = new awarenessProtocol.Awareness(doc);
    const active: ActiveFile = {
      fileId,
      projectId: file.project_id,
      doc,
      text,
      awareness,
      clients: new Set(),
      lastActor: { type: 'system', id: 'collaboration', name: 'Collaboration' },
      persistedRevision: file.revision_hash,
      persistedYStateHash: revisionHash(Y.encodeStateAsUpdate(doc)),
      disposed: false
    };

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const source = origin as { actor?: ActorIdentity } | CollabSocket | null;
      if (source && 'actor' in source && source.actor) active.lastActor = source.actor;
      this.broadcastUpdate(active, update, origin);
      this.schedulePersist(active);
    });
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = added.concat(updated, removed);
      if (origin && typeof origin === 'object' && 'controlledAwarenessIds' in origin) {
        const originSocket = origin as CollabSocket;
        for (const id of added.concat(updated)) originSocket.controlledAwarenessIds?.add(id);
        for (const id of removed) originSocket.controlledAwarenessIds?.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      this.broadcast(active, encoding.toUint8Array(encoder), null);
    });
    this.active.set(fileId, active);
    return active;
  }

  private onMessage(active: ActiveFile, socket: CollabSocket, raw: RawData): void {
    try {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(Buffer.from(raw as any));
      if (bytes.byteLength > 2 * 1024 * 1024) {
        socket.close(1009, 'Message too large');
        return;
      }
      const decoder = decoding.createDecoder(bytes);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, active.doc, socket);
        if (encoding.length(encoder) > 1 && socket.readyState === socket.OPEN) {
          socket.send(encoding.toUint8Array(encoder));
        }
      } else if (type === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        const entries = decodeAwarenessEntries(update);
        const controlled = socket.controlledAwarenessIds ?? new Set<number>();
        const unauthorized = entries.some(({ clientId, state }) => {
          if (!controlled.has(clientId) && (controlled.size >= 1 || active.awareness.getStates().has(clientId))) return true;
          if (state == null) return !controlled.has(clientId);
          const user = state.user as { id?: string; name?: string } | undefined;
          return user?.id !== socket.actor?.id || user?.name !== socket.actor?.name;
        });
        if (unauthorized) {
          socket.close(1008, 'Invalid awareness identity');
          return;
        }
        awarenessProtocol.applyAwarenessUpdate(active.awareness, update, socket);
      } else if (type === MESSAGE_FLUSH_REQUEST) {
        const requestId = decoding.readVarUint(decoder);
        void this.flush(active).then(() => {
          if (socket.readyState !== socket.OPEN) return;
          const response = encoding.createEncoder();
          encoding.writeVarUint(response, MESSAGE_FLUSH_ACK);
          encoding.writeVarUint(response, requestId);
          socket.send(encoding.toUint8Array(response));
        });
      }
    } catch {
      socket.close(1003, 'Invalid collaboration message');
    }
  }

  private broadcastUpdate(active: ActiveFile, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(active, encoding.toUint8Array(encoder), origin);
  }

  private broadcast(active: ActiveFile, message: Uint8Array, origin: unknown): void {
    for (const client of active.clients) {
      if (client !== origin && client.readyState === client.OPEN) client.send(message);
    }
  }

  private scheduleEviction(active: ActiveFile): void {
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = setTimeout(() => {
      active.idleTimer = undefined;
      if (active.clients.size || active.disposed) return;
      void this.flush(active).then(() => {
        if (active.clients.size || active.disposed) return;
        active.disposed = true;
        active.awareness.destroy();
        active.doc.destroy();
        this.active.delete(active.fileId);
      });
    }, 5 * 60_000);
    active.idleTimer.unref();
  }

  private schedulePersist(active: ActiveFile): void {
    if (active.disposed) return;
    if (active.persistTimer) clearTimeout(active.persistTimer);
    active.persistTimer = setTimeout(() => void this.flush(active), PERSIST_DELAY_MS);
  }

  private async flush(active: ActiveFile, emitAgentEvent = false): Promise<FileRecord> {
    if (active.disposed) throw new Error('Collaborative file is disposed');
    if (active.persistTimer) {
      clearTimeout(active.persistTimer);
      active.persistTimer = undefined;
    }
    const content = Buffer.from(active.text.toString());
    const existing = this.store.getFileById(active.fileId);
    if (!existing) throw new Error('File removed while active');
    const revision = fileRevision(existing.path, content);
    const yState = Y.encodeStateAsUpdate(active.doc);
    const yStateHash = revisionHash(yState);
    if (revision === active.persistedRevision && yStateHash === active.persistedYStateHash) return existing;
    const saved = this.store.saveFile(active.fileId, content, active.lastActor, false, yState);
    this.store.addRevision(active.fileId, content, active.lastActor);
    active.persistedRevision = revision;
    active.persistedYStateHash = yStateHash;
    this.events.emit(active.projectId, {
      type: emitAgentEvent || active.lastActor.type === 'agent' ? 'agent.changed' : 'file.changed',
      fileId: active.fileId,
      path: existing.path,
      revision,
      actor: active.lastActor
    });
    return saved;
  }
}

function decodeAwarenessEntries(update: Uint8Array): Array<{ clientId: number; state: Record<string, unknown> | null }> {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const entries: Array<{ clientId: number; state: Record<string, unknown> | null }> = [];
  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown> | null;
    entries.push({ clientId, state });
  }
  return entries;
}
