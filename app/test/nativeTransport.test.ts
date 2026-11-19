import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthdeckSocketNative } from '../modules/authdeck-socket';
import { MAX_PENDING_WRITE_BYTES, nativeTransport } from '../src/net/tcp';

type Listener = (event: { id: number; data?: string; message?: string }) => void;

/** A stand-in for the native module: records calls and lets a test fire events. */
function fakeModule() {
  const listeners = new Map<string, Listener[]>();
  const calls: string[] = [];
  let nextId = 1;
  let connectResult: (() => void) | null = null;
  let writeResolvers: (() => void)[] = [];
  const module = {
    connect: (host: string, port: number) =>
      new Promise<number>((resolve) => {
        calls.push(`connect ${host}:${port}`);
        const id = nextId++;
        connectResult = () => resolve(id);
      }),
    write: (id: number, data: string) =>
      new Promise<void>((resolve) => {
        calls.push(`write ${id} ${data}`);
        writeResolvers.push(resolve);
      }),
    ack: (id: number, bytes: number) => void calls.push(`ack ${id} ${bytes}`),
    close: (id: number) => void calls.push(`close ${id}`),
    addListener: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return { remove() {} };
    },
  };
  return {
    module: module as unknown as AuthdeckSocketNative,
    calls,
    emit: (event: string, payload: { id: number; data?: string; message?: string }) => listeners.get(event)?.forEach((l) => l(payload)),
    resolveConnect: () => connectResult?.(),
    finishWrites: () => {
      writeResolvers.forEach((r) => r());
      writeResolvers = [];
    },
    listenerCount: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the native transport', () => {
  it('shares one set of subscriptions across sockets and dispatches by id', async () => {
    const fake = fakeModule();
    const transport = nativeTransport(fake.module);
    const pending = [transport.connect('h', 1, 100), transport.connect('h', 2, 100)];
    fake.resolveConnect();
    const second = await pending[1]!;
    assert.equal(fake.listenerCount(), 3);
    const got: number[][] = [];
    second.onData = (bytes) => got.push([...bytes]);
    fake.emit('onData', { id: 2, data: 'AQID' });
    fake.emit('onData', { id: 99, data: 'BAU=' });
    assert.deepEqual(got, [[1, 2, 3]]);
  });

  it('decodes base64, and acks only what the reader acks', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect();
    const stream = await pending;
    stream.onData = (bytes) => stream.ack(bytes.length - 1);
    fake.emit('onData', { id: 1, data: 'AQID' });
    assert.ok(fake.calls.includes('ack 1 2'));
  });

  it('holds events that arrive before connect resolves, and hands them over after', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.emit('onData', { id: 1, data: 'AQ==' });
    fake.resolveConnect();
    const stream = await pending;
    const got: number[][] = [];
    stream.onData = (bytes) => got.push([...bytes]);
    // One more arrives before the early one is handed over: order is kept.
    fake.emit('onData', { id: 1, data: 'Ag==' });
    await tick();
    assert.deepEqual(got, [[1], [2]]);
  });

  it('a late event for a closed id does nothing', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect();
    const stream = await pending;
    let events = 0;
    stream.onData = () => events++;
    stream.onClose = () => events++;
    stream.onError = () => events++;
    stream.close();
    fake.emit('onData', { id: 1, data: 'AQ==' });
    fake.emit('onError', { id: 1, message: 'x' });
    fake.emit('onClose', { id: 1 });
    stream.write(Uint8Array.of(1));
    assert.equal(events, 0);
    assert.equal(fake.calls.filter((c) => c.startsWith('write')).length, 0);
  });

  it('close lets a write in flight go out first, then closes natively', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect();
    const stream = await pending;
    stream.write(Uint8Array.of(0x88, 0x80));
    stream.close();
    await tick();
    assert.equal(fake.calls.includes('close 1'), false);
    fake.finishWrites();
    await tick();
    assert.ok(fake.calls.includes('close 1'));
  });

  it('ends the connection when writes pile up past the cap (a peer that stops reading)', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect();
    const stream = await pending;
    const seen: string[] = [];
    stream.onError = (message) => seen.push(`error ${message}`);
    stream.onClose = () => seen.push('close');
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i <= MAX_PENDING_WRITE_BYTES / chunk.length; i++) stream.write(chunk);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], 'close');
    assert.ok(fake.calls.includes('close 1'));
  });

  it('a reader that throws ends only its own connection', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect();
    const stream = await pending;
    let closed = false;
    stream.onData = () => {
      throw new Error('bug');
    };
    stream.onClose = () => (closed = true);
    assert.doesNotThrow(() => fake.emit('onData', { id: 1, data: 'AQ==' }));
    assert.equal(closed, true);
    assert.ok(fake.calls.includes('close 1'));
  });
});
