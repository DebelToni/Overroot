import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Database } from '../src/database.js';
import { ProjectStore } from '../src/project-store.js';
import type { WebSocketTicket } from '../src/websockets.js';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let dir: string;
const clients: WebSocket[] = [];
afterEach(async () => {
  // Also releases a deliberately failing pre-fix reproduction's blocked close.
  for (const client of clients.splice(0)) client.terminate();
  if (app) await app.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'overroot-shutdown-'));
  const harness = await buildApp({ databasePath: join(dir, 'state.sqlite3'), logger: false });
  app = harness.app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  return harness;
}

async function connect(ticket: WebSocketTicket, suffix: string) {
  const port = (app.server.address() as AddressInfo).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/${ticket.projectHash}/${suffix}?ticket=${encodeURIComponent(ticket.token)}`);
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return client;
}

async function closePromptly() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Shutdown remained blocked by open WebSockets')), 2000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

it.each([0, 1, 3])('closes a listening app with %i live event sockets without waiting for client disconnection', async count => {
  const { context } = await setup();
  const received = new Set<number>();
  const closes: Array<Promise<number>> = [];
  for (let i = 0; i < count; i++) {
    const ticket = context.tickets.create({
      channel: 'events', projectId: 'fixture', projectHash: 'fixture', sessionHash: 'fixture',
      actor: { type: 'user', id: 'fixture', name: 'Fixture' }
    });
    const client = await connect(ticket, 'events');
    client.on('message', raw => {
      if (JSON.parse(raw.toString()).type === 'shutdown.probe') received.add(i);
    });
    closes.push(new Promise<number>(resolve => client.once('close', code => resolve(code))));
  }
  context.events.emit('fixture', { type: 'shutdown.probe' });
  await vi.waitFor(() => expect(received.size).toBe(count));
  await closePromptly();
  expect(await Promise.all(closes)).toEqual(Array(count).fill(1001));
  expect(() => context.events.emit('fixture', { type: 'after.shutdown' })).not.toThrow();
});

it('flushes a pending collaborative edit before closing the database during live-socket shutdown', async () => {
  const { context } = await setup();
  const user = await context.auth.createUser('shutdown-writer', 'shutdown-writer-password', true);
  const project = context.projects.createProject(user.id, 'Shutdown persistence');
  const file = context.projects.getFile(project.id, 'main.tex')!;
  const ticket = context.tickets.create({
    channel: 'file', projectId: project.id, projectHash: project.public_hash, fileId: file.id, sessionHash: 'fixture',
    actor: { type: 'user', id: user.id, name: user.username }
  });
  const client = await connect(ticket, `files/${file.id}`);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, file.y_state!);
    doc.getText('content').insert(doc.getText('content').length, '\n% Pending edit survives shutdown\n');
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 0);
    syncProtocol.writeUpdate(message, Y.encodeStateAsUpdate(doc));
    client.send(encoding.toUint8Array(message));
    await vi.waitFor(() => expect(Buffer.from(context.collaboration.current(file.id).content).toString()).toContain('Pending edit survives shutdown'));
    expect(Buffer.from(context.projects.getFileById(file.id)!.content).toString()).not.toContain('Pending edit survives shutdown');
    await closePromptly();
    const reopened = new Database(join(dir, 'state.sqlite3'));
    try {
      expect(Buffer.from(new ProjectStore(reopened).getFileById(file.id)!.content).toString()).toBe(doc.getText('content').toString());
    } finally {
      reopened.close();
    }
  } finally {
    doc.destroy();
  }
});
