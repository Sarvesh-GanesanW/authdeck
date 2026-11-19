import { Platform, nodeTcp } from './native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { RequestError, openSession, pairWithPin } from '../src/net/client';
import { ConnectionManager } from '../src/net/connection';
import { fetchHello } from '../src/net/discovery';
import { setTcpTransport, type TcpTransport } from '../src/net/tcp';
import {
  CONNECT_CANARY_KEY,
  ConnectCanary,
  HeldHostError,
  STORAGE_WARNING,
  afterLaunch,
  connectCanary,
  heldNotice,
  readMark,
  useConnectCanary,
  writeMark,
} from '../src/state/connectCanary';
import { useLive } from '../src/state/live';
import type { Computer } from '../src/state/model';
import { useStore } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, newLinkKey, waitFor } from './linkServers';

const V4 = '127.0.0.1';
const device = newLinkKey();
const computer = newLinkKey();

/** An in-memory AsyncStorage, one per simulated launch history. */
function memoryStorage(failWrites = false) {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (failWrites) throw new Error('disk full');
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

/** The addresses with a session or pairing connection under way in the saved mark. */
const connecting = (storage: { values: Map<string, string> }): string[] => readMark(storage.values.get(CONNECT_CANARY_KEY) ?? null).connecting;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => useConnectCanary.setState({ held: [], noticeShown: false, storageWarning: false }));

/** This launch closes while connecting to `host`: the connection never settles. */
async function closeWhileConnecting(canary: ConnectCanary, storage: ReturnType<typeof memoryStorage>, host: string): Promise<void> {
  void canary.guard(host, () => new Promise(() => undefined));
  await waitFor('the mark', () => connecting(storage).includes(host));
}

/** Waits for a check against saved storage, which is read asynchronously. */
async function waitForSaved(what: string, check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A fresh launch over `storage`: reads the mark and says what it holds. */
async function launch(storage: ReturnType<typeof memoryStorage>, now = () => Date.now()): Promise<ConnectCanary> {
  useConnectCanary.setState({ held: [], noticeShown: false, storageWarning: false });
  const canary = new ConnectCanary(storage, now);
  await canary.check();
  return canary;
}

describe('the connection canary', () => {
  it('names the address in the saved mark before the connection starts, and clears it once it settles', async () => {
    const storage = memoryStorage();
    const canary = new ConnectCanary(storage);
    let markDuringConnect: string[] = [];
    await canary.guard('192.168.1.9', async () => {
      markDuringConnect = connecting(storage);
    });
    assert.deepEqual(markDuringConnect, ['192.168.1.9']);
    await waitFor('the mark to clear', () => !storage.values.has(CONNECT_CANARY_KEY));
  });

  it('clears the mark after a connection that fails cleanly', async () => {
    const storage = memoryStorage();
    const canary = new ConnectCanary(storage);
    await assert.rejects(canary.guard('192.168.1.9', async () => Promise.reject(new Error('refused'))), /refused/);
    await waitFor('the mark to clear', () => !storage.values.has(CONNECT_CANARY_KEY));
  });

  it('names every address with a connection under way', async () => {
    const storage = memoryStorage();
    const canary = new ConnectCanary(storage);
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => (release = resolve));
    const first = canary.guard('10.0.0.1', () => hanging);
    let seen: string[] = [];
    await canary.guard('10.0.0.2', async () => {
      seen = connecting(storage);
    });
    assert.deepEqual(seen.sort(), ['10.0.0.1', '10.0.0.2']);
    release();
    await first;
    await waitFor('the mark to clear', () => !storage.values.has(CONNECT_CANARY_KEY));
  });

  it('L4: one launch closing mid-connect (a swipe, a background kill) holds nothing', async () => {
    const storage = memoryStorage();
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');
    const next = await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, []);
    let connected = false;
    await next.guard('192.168.1.9', async () => {
      connected = true;
    });
    assert.equal(connected, true);
  });

  it('L-B: launches closed away from the foreground hold nothing; back in front, the connection is named again', async () => {
    const storage = memoryStorage();
    for (let launchNo = 0; launchNo < 2; launchNo++) {
      const canary = await launch(storage);
      await closeWhileConnecting(canary, storage, '192.168.1.9');
      canary.setForeground(false);
      await waitFor('the mark drops it', () => connecting(storage).length === 0);
    }
    const third = await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, []);
    await closeWhileConnecting(third, storage, '192.168.1.9');
    third.setForeground(false);
    await waitFor('the mark drops it', () => connecting(storage).length === 0);
    // A connection started in the background is not named either, until the app is in front again.
    void third.guard('192.168.1.10', () => new Promise(() => undefined));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(connecting(storage), []);
    third.setForeground(true);
    await waitFor('both named again', () => connecting(storage).length === 2);
  });

  it('L4: two launches in a row closing while connecting to the same address hold it until Connect', async () => {
    const storage = memoryStorage();
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');

    const third = await launch(storage);
    assert.deepEqual(useConnectCanary.getState(), { held: ['192.168.1.9'], noticeShown: true, storageWarning: false });
    let connected = false;
    await assert.rejects(
      third.guard('192.168.1.9', async () => {
        connected = true;
      }),
      HeldHostError,
    );
    assert.equal(connected, false);
    // Another address is not held.
    await third.guard('192.168.1.10', async () => undefined);

    third.hideNotice();
    assert.equal(useConnectCanary.getState().noticeShown, false);
    await third.release('192.168.1.9');
    assert.deepEqual(useConnectCanary.getState().held, []);
    await third.guard('192.168.1.9', async () => {
      connected = true;
    });
    assert.equal(connected, true);
  });

  it('L4: a launch in between that did not close mid-connect there starts the count again', async () => {
    const storage = memoryStorage();
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');
    // The second launch connects there cleanly, then closes while connecting somewhere else.
    const second = await launch(storage);
    await second.guard('192.168.1.9', async () => undefined);
    await closeWhileConnecting(second, storage, '192.168.1.20');
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');
    await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, []);
  });

  it('L4: two strikes a week or more apart hold nothing', async () => {
    const storage = memoryStorage();
    let now = Date.now();
    await closeWhileConnecting(await launch(storage, () => now), storage, '192.168.1.9');
    // The next launch counts its strike now, and stays open for 8 days before it closes mid-connect there.
    const second = await launch(storage, () => now);
    now += 8 * DAY_MS;
    await closeWhileConnecting(second, storage, '192.168.1.9');
    await launch(storage, () => now);
    assert.deepEqual(useConnectCanary.getState().held, []);
  });

  it('L4: a held address is let go after 7 days', async () => {
    const storage = memoryStorage();
    let now = Date.now();
    await closeWhileConnecting(await launch(storage, () => now), storage, '192.168.1.9');
    await closeWhileConnecting(await launch(storage, () => now), storage, '192.168.1.9');
    await launch(storage, () => now);
    assert.deepEqual(useConnectCanary.getState().held, ['192.168.1.9']);

    now += 6 * DAY_MS;
    await launch(storage, () => now);
    assert.deepEqual(useConnectCanary.getState().held, ['192.168.1.9'], 'still held after 6 days');
    now += 2 * DAY_MS;
    await launch(storage, () => now);
    assert.deepEqual(useConnectCanary.getState().held, []);
  });

  it('L4: a launch that closes during a sweep holds nothing, even an address it was connecting to', async () => {
    const storage = memoryStorage();
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');
    const second = await launch(storage);
    void second.duringSweep(() => new Promise(() => undefined));
    void second.guard('192.168.1.9', () => new Promise(() => undefined));
    await waitFor('the mark', () => connecting(storage).includes('192.168.1.9') && readMark(storage.values.get(CONNECT_CANARY_KEY)!).sweeping);
    // The launch after holds nothing, and its strikes start over: one more close there holds nothing either.
    await closeWhileConnecting(await launch(storage), storage, '192.168.1.9');
    assert.deepEqual(useConnectCanary.getState().held, []);
    await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, []);
  });

  it('L4: Connect leaves one strike, so closing mid-connect there once more holds it again', async () => {
    const storage = memoryStorage();
    storage.values.set(CONNECT_CANARY_KEY, writeMark({ held: new Map([['192.168.1.9', Date.now()]]), strikes: new Map(), connecting: [], sweeping: false }));
    const first = await launch(storage);
    await first.release('192.168.1.9');
    void first.guard('192.168.1.9', () => new Promise(() => undefined));
    await waitFor('the mark', () => connecting(storage).includes('192.168.1.9'));
    await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, ['192.168.1.9']);
  });

  it('Not now keeps the address held on the next launch too', async () => {
    const storage = memoryStorage();
    storage.values.set(CONNECT_CANARY_KEY, writeMark({ held: new Map([['192.168.1.9', Date.now()]]), strikes: new Map(), connecting: [], sweeping: false }));
    const first = await launch(storage);
    first.hideNotice();
    await first.guard('192.168.1.10', async () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, ['192.168.1.9']);
  });

  it('the first version’s mark counts as one strike, not a hold', async () => {
    const storage = memoryStorage();
    storage.values.set(CONNECT_CANARY_KEY, JSON.stringify(['192.168.1.9']));
    const first = await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, []);
    await closeWhileConnecting(first, storage, '192.168.1.9');
    await launch(storage);
    assert.deepEqual(useConnectCanary.getState().held, ['192.168.1.9']);
  });

  it('L1: when the mark cannot be saved the connection goes ahead and the warning shows, once', async () => {
    const canary = new ConnectCanary(memoryStorage(true));
    let connected = 0;
    await canary.guard('192.168.1.9', async () => {
      connected++;
    });
    assert.equal(connected, 1);
    assert.equal(useConnectCanary.getState().storageWarning, true);
    assert.equal(STORAGE_WARNING, "AuthDeck couldn't save its connection notes. Storage may be full.");
    canary.dismissStorageWarning();
    await canary.guard('192.168.1.10', async () => {
      connected++;
    });
    await canary.duringSweep(async () => undefined);
    assert.equal(connected, 2);
    assert.equal(useConnectCanary.getState().storageWarning, false, 'said once a launch');
  });

  it('an unreadable mark holds nothing', async () => {
    const storage = memoryStorage();
    for (const raw of ['{not json', '{"v":2,"held":"x"}', '{"v":2,"held":[["__proto__",1],[5,1]]}', 'null', '{"v":9}']) {
      storage.values.set(CONNECT_CANARY_KEY, raw);
      await launch(storage);
      assert.deepEqual(useConnectCanary.getState().held, [], raw);
    }
  });

  it('a "__proto__" address is held like any other', () => {
    const now = Date.now();
    const struck = readMark(writeMark({ held: new Map(), strikes: new Map([['__proto__', now]]), connecting: ['__proto__'], sweeping: false }));
    assert.deepEqual([...afterLaunch(struck, now).held.keys()], ['__proto__']);
  });

  it('the notice names the address, and a count past three', () => {
    assert.equal(heldNotice(['192.168.1.9']), 'AuthDeck closed while connecting to 192.168.1.9. Connect again?');
    assert.match(heldNotice(['a', 'b', 'c', 'd', 'e']), /a, b, c and 2 more\./);
  });
});

describe('the app’s connections go through the canary on a phone', () => {
  const servers: TestServer[] = [];
  let stop: (() => void) | null = null;
  after(() => Promise.all(servers.map((s) => s.close())));
  afterEach(() => {
    stop?.();
    stop = null;
    setTcpTransport(nodeTcp);
  });

  it('the mark is saved before the TCP connect starts, for sessions, pairing and /hello', async () => {
    Platform.OS = 'ios';
    const server = await agentServer(V4, 0, { key: computer, info: agentInfo('mac') });
    servers.push(server);
    const marksAtConnect: (string | null)[] = [];
    const spy: TcpTransport = {
      connect: async (host, port, timeoutMs) => {
        marksAtConnect.push(await AsyncStorage.getItem(CONNECT_CANARY_KEY));
        return nodeTcp.connect(host, port, timeoutMs);
      },
    };
    setTcpTransport(spy);
    const { session } = await openSession(V4, server.port, device, computer.public);
    session.close();
    await pairWithPin([V4], server.port, '000000', device, { deviceId: 'd', deviceName: 'Phone' });
    await fetchHello(V4, server.port, 500);
    assert.equal(marksAtConnect.length, 3);
    for (const saved of marksAtConnect) assert.deepEqual(readMark(saved).connecting, [V4]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await AsyncStorage.getItem(CONNECT_CANARY_KEY), null);
  });

  it('L-B: one held address is skipped; the computer connects at its other address', async () => {
    Platform.OS = 'android';
    const server = await agentServer(V4, 0, { key: computer, info: agentInfo('mac') });
    servers.push(server);
    const contacted: string[] = [];
    setTcpTransport({ connect: (host, port, timeoutMs) => (contacted.push(host), nodeTcp.connect(host, port, timeoutMs)) });
    useConnectCanary.setState({ held: ['::1'], noticeShown: false });
    const saved: Computer = { agentId: 'mac', name: 'Mac', platform: 'macos', hosts: ['::1', V4], port: server.port, linkKey: toBase64Url(computer.public), pairedAt: 1 };
    useStore.setState({ computers: [saved], activeId: 'mac' });
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('online', () => useLive.getState().status === 'online');
    assert.deepEqual(contacted, [V4]);
    assert.deepEqual(useConnectCanary.getState().held, ['::1'], 'the held address stays held');
  });

  it('L-B: leaving the foreground takes connections under way out of the saved mark', async () => {
    Platform.OS = 'android';
    // Set by the manager's AppState listener; asserted wide so the callback's assignment isn't narrowed away.
    let onChange = null as ((state: string) => void) | null;
    const hung: ((err: Error) => void)[] = [];
    const listen = AppState.addEventListener;
    AppState.addEventListener = ((_event: string, listener: (state: string) => void) => {
      onChange = listener;
      return { remove() {} };
    }) as never;
    try {
      const saved: Computer = { agentId: 'mac', name: 'Mac', platform: 'macos', hosts: [V4], port: 9, linkKey: toBase64Url(computer.public), pairedAt: 1 };
      useStore.setState({ computers: [saved], activeId: 'mac' });
      // A connect that hangs, as at a tarpit, until the test ends it.
      setTcpTransport({ connect: () => new Promise((_, reject) => hung.push(reject)) });
      const manager = new ConnectionManager(async () => [], async () => null);
      stop = manager.init();
      const marked = async () => readMark(await AsyncStorage.getItem(CONNECT_CANARY_KEY)).connecting;
      await waitForSaved('marked', async () => (await marked()).includes(V4));
      onChange!('background');
      await waitForSaved('unmarked', async () => (await marked()).length === 0);
      onChange!('active');
      await waitForSaved('marked again', async () => (await marked()).includes(V4));
    } finally {
      onChange?.('active');
      AppState.addEventListener = listen;
      for (const reject of hung) reject(new Error('test over'));
      await waitForSaved('the mark cleared', async () => (await AsyncStorage.getItem(CONNECT_CANARY_KEY)) === null);
    }
  });

  it('a held address is not contacted until Connect; then the computer connects', async () => {
    Platform.OS = 'ios';
    const server = await agentServer(V4, 0, { key: computer, info: agentInfo('mac') });
    servers.push(server);
    useConnectCanary.setState({ held: [V4], noticeShown: false });
    await AsyncStorage.setItem(CONNECT_CANARY_KEY, JSON.stringify([V4]));

    const refused = await openSession(V4, server.port, device, computer.public).then(
      () => assert.fail('opened'),
      (e: unknown) => e,
    );
    assert.ok(refused instanceof RequestError);
    assert.equal(refused.code, 'offline');
    assert.match(refused.message, /closed while connecting to 127\.0\.0\.1/);
    assert.equal(useConnectCanary.getState().noticeShown, true, 'a refusal shows the notice again');
    assert.equal(await fetchHello(V4, server.port, 300), null);

    // The saved computer at that address stays offline: no automatic connect.
    const saved: Computer = { agentId: 'mac', name: 'Mac', platform: 'macos', hosts: [V4], port: server.port, linkKey: toBase64Url(computer.public), pairedAt: 1 };
    useStore.setState({ computers: [saved], activeId: 'mac' });
    connectCanary.hideNotice();
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('offline', () => useLive.getState().status === 'offline');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(server.connections(), 0);
    assert.equal(useLive.getState().status, 'offline');

    // A key press while held brings the notice back instead of a generic offline toast.
    await manager.runKey({ id: 'k', label: 'Code', icon: { kind: 'glyph', name: 'code' }, action: { type: 'launch', appId: 'code' } } as never, { cwd: undefined } as never);
    assert.equal(useConnectCanary.getState().noticeShown, true);

    // Connect, as the notice does it.
    await connectCanary.release(V4);
    manager.wake();
    await waitFor('online', () => useLive.getState().status === 'online');
    assert.equal(server.connections(), 1);
  });
});
