import * as awarenessProtocol from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api';
import { TicketedYProvider } from './y-provider';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: Uint8Array[] = [];
  binaryType = 'blob';
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string' || data instanceof Blob) throw new Error('Expected a binary WebSocket message');
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.sent.push(new Uint8Array(bytes));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  private emit(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('TicketedYProvider', () => {
  it('announces only local awareness after reconnecting with cached collaborators', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const api = {
      createWsTicket: vi.fn().mockResolvedValue({ ticket: 'ticket', path: '/file', expiresAt: '' }),
      websocketUrl: vi.fn(() => 'wss://overroot.test/file')
    } as unknown as ApiClient;
    const doc = new Y.Doc();
    const provider = new TicketedYProvider(api, 'project', 'file', doc);
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new awarenessProtocol.Awareness(remoteDoc);

    try {
      provider.awareness.setLocalStateField('user', { id: 'local', name: 'Local user' });
      await settle();
      const first = FakeWebSocket.instances[0]!;
      first.open();

      remoteAwareness.setLocalStateField('user', { id: 'remote', name: 'Remote user' });
      awarenessProtocol.applyAwarenessUpdate(
        provider.awareness,
        awarenessProtocol.encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        provider
      );
      expect(provider.awareness.getStates().has(remoteDoc.clientID)).toBe(true);

      first.close();
      await vi.advanceTimersByTimeAsync(500);
      await settle();
      const second = FakeWebSocket.instances[1]!;
      second.open();

      expect(awarenessClientIds(second.sent)).toEqual([[doc.clientID]]);
    } finally {
      provider.destroy();
      remoteAwareness.destroy();
      remoteDoc.destroy();
      doc.destroy();
    }
  });
});

function awarenessClientIds(messages: Uint8Array[]): number[][] {
  return messages.flatMap((message) => {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== 1) return [];
    const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
    const count = decoding.readVarUint(update);
    const ids: number[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(decoding.readVarUint(update));
      decoding.readVarUint(update);
      decoding.readVarString(update);
    }
    return [ids];
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
