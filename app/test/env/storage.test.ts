// The device's env storage (auth/env/storage.ts): copies keep values encrypted at rest, keys go
// only to secure storage, a copy changed on disk or torn by a crash is never trusted, and the
// engine reads its sets back after a restart.
import '../native';
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-secure-store') return { url: pathToFileURL(path.join(__dirname, '..', 'stubs', 'securestore.cjs')).href, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
/* eslint-disable @typescript-eslint/no-require-imports */
const { DeviceEnvStore } = require('../../src/auth/env/storage') as typeof import('../../src/auth/env/storage');
const secureStore = require('expo-secure-store') as { __secure: Map<string, string> };
const fileSystem = require('expo-file-system') as { root: string; faults: { tearNext(match: RegExp, keep: number): void } };
const fakes = require('./fakes') as typeof import('./fakes');
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = 'sk_live_very_secret_value_42';

afterEach(fakes.disposeAll);

function allFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** An engine over the device store, with a set made on it. */
async function madeOnDevice(folder: string) {
  const { Directory, Paths } = await import('expo-file-system');
  const store = new DeviceEnvStore(() => new Directory(Paths.document, folder));
  const r = await fakes.rig({ store: store as never });
  const setId = await fakes.createdSet(r, [{ name: 'API_KEY', value: SECRET }]);
  return { r, store, setId };
}

describe('env storage on the device', () => {
  it('keeps values encrypted at rest: no plain value in any file, keys only in secure storage', async () => {
    const { r, setId } = await madeOnDevice('env-at-rest');
    await r.engine.saveVariable(setId, { name: 'DB_PASSWORD', value: `${SECRET}-db` });
    const files = allFiles(fileSystem.root);
    assert.ok(files.some((f) => f.includes('env-at-rest')));
    for (const file of files) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), `${file} holds a plain value`);
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    for (const key of await asyncStorage.getAllKeys()) assert.ok(!(await asyncStorage.getItem(key))!.includes(SECRET));

    const secureNames = [...secureStore.__secure.keys()];
    assert.ok(secureNames.includes('authdeck_env_device_v1'));
    assert.ok(secureNames.includes(`authdeck_env_keys_${setId}`));
    assert.ok(secureNames.includes(`authdeck_env_trust_${setId}`));
    for (const value of secureStore.__secure.values()) assert.ok(!value.includes(SECRET));
  });

  it('a restarted engine reads its copy back and opens values again', async () => {
    const { r, store, setId } = await madeOnDevice('env-restart');
    const again = await fakes.rig({ store: store as never, device: r.device, computer: null });
    assert.equal(again.engine.snapshot().sets[0]?.id, setId);
    assert.equal(await again.engine.reveal(setId, 'API_KEY'), SECRET);
  });

  it('a copy changed on disk fails its anchor and is set aside', async () => {
    const { store, setId } = await madeOnDevice('env-tamper');
    const slot = allFiles(fileSystem.root).find((f) => f.includes('env-tamper') && f.includes(setId))!;
    const stored = JSON.parse(fs.readFileSync(slot, 'utf8')) as { gen: number; body: string; check: string };
    const body = JSON.parse(stored.body) as { trust: { head: { versions: Record<string, number> } } };
    body.trust.head.versions.API_KEY = 0;
    const { createHash } = await import('node:crypto');
    const newBody = JSON.stringify(body);
    const check = createHash('sha256').update(`${stored.gen}\n${newBody}`).digest('base64url');
    fs.writeFileSync(slot, JSON.stringify({ gen: stored.gen, body: newBody, check }));
    const fresh = new DeviceEnvStore((store as unknown as { root: () => never }).root);
    const loaded = await fresh.loadSets();
    assert.deepEqual(loaded.sets, []);
    assert.equal(loaded.damaged.length, 1);
    assert.equal(loaded.damaged[0]!.setId, setId);
    assert.equal(loaded.damaged[0]!.floor?.rev, 1);
  });

  it('a copy set aside is taken again only from a file at or past what its anchor vouched for', async () => {
    const { r, store, setId } = await madeOnDevice('env-floor');
    const realText = r.agent.sets.get(setId)!.text;
    for (const slot of allFiles(fileSystem.root).filter((f) => f.includes('env-floor') && f.includes(setId))) fs.writeFileSync(slot, 'damaged');
    // The copy is gone; the anchor stays. A stranger's set under the same id that lists this device is not taken.
    const { generateDeviceKeys } = await import('../../src/vault/crypto');
    const stranger = generateDeviceKeys(r.random);
    const forged = fakes.externalSet(stranger, r.random, { setId, members: [r.device] });
    const fresh = new DeviceEnvStore((store as unknown as { root: () => never }).root);
    const again = await fakes.rig({ store: fresh as never, device: r.device, computer: null });
    again.agent.put(setId, 'acme-api', forged.text);
    await again.engine.computerChanged(fakes.COMPUTER);
    assert.notEqual(again.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'member');
    // The real file at the anchored rev is, even with the stranger's file in its history (it fails its own checks).
    again.agent.put(setId, 'acme-api', realText);
    await again.engine.sync();
    assert.equal(again.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'owner');
    assert.equal(await again.engine.reveal(setId, 'API_KEY'), SECRET);
  });

  it('a write torn by a crash leaves the previous slot readable', async () => {
    const { r, store, setId } = await madeOnDevice('env-torn');
    fileSystem.faults.tearNext(new RegExp(`^${setId}\\.`), 10);
    await assert.rejects(r.engine.saveVariable(setId, { name: 'X', value: '1' }));
    const fresh = new DeviceEnvStore((store as unknown as { root: () => never }).root);
    const loaded = await fresh.loadSets();
    assert.deepEqual(loaded.damaged, []);
    const again = await fakes.rig({ store: fresh as never, device: r.device, computer: null });
    assert.equal(await again.engine.reveal(setId, 'API_KEY'), SECRET);
  });
});

describe('join pins on the device', () => {
  it('a pin edited on disk fails its anchor and is dropped: the set stays outside until the person asks again', async () => {
    const { Directory, Paths } = await import('expo-file-system');
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const maya = await fakes.rig({ seed: 'pin-owner' });
    const setId = await fakes.createdSet(maya, [{ name: 'API_KEY', value: SECRET }]);
    const store = new DeviceEnvStore(() => new Directory(Paths.document, 'env-pin'));
    const chen = await fakes.rig({ seed: 'pin-teammate', store: store as never });
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await chen.engine.sync();
    fakes.ask(chen, fakes.joinKeysRequest(chen.agent, 'jk-pin', setId));
    await chen.engine.answer('jk-pin', 'approve');
    assert.equal((await new DeviceEnvStore(() => new Directory(Paths.document, 'env-pin')).loadPrefs()).ownRequests.length, 1, 'an untouched pin loads');

    // Someone with the app's files swaps the pin for one of their own set's head.
    const raw = JSON.parse((await asyncStorage.getItem('authdeck-env-prefs-v1'))!) as { ownRequests: { pin: { head: { headerHash: string } } }[] };
    raw.ownRequests[0]!.pin.head.headerHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await asyncStorage.setItem('authdeck-env-prefs-v1', JSON.stringify(raw));
    const loaded = await new DeviceEnvStore(() => new Directory(Paths.document, 'env-pin')).loadPrefs();
    assert.deepEqual(loaded.ownRequests, []);

    // The owner's file that now lists this device is not taken without the pin.
    const { addEnvMember, verifyEnvFile, writeEnvFile } = await import('../../src/envcore');
    const current = verifyEnvFile(maya.agent.sets.get(setId)!.text, null);
    assert.ok(current.ok);
    const withChen = addEnvMember({
      file: current.set.file,
      owner: maya.device,
      dataKeys: { 1: maya.store.keys.get(setId)![1]! },
      time: 7,
      member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
    });
    const fresh = new DeviceEnvStore(() => new Directory(Paths.document, 'env-pin'));
    const again = await fakes.rig({ store: fresh as never, device: chen.device, computer: null });
    again.agent.put(setId, 'acme-api', writeEnvFile(withChen));
    await again.engine.computerChanged(fakes.COMPUTER);
    assert.equal(again.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'outside');
  });
});

describe('withdrawing a request to join', () => {
  /** Maya's set, Chen's request for it approved and the owner's words confirmed, its file on the computer. */
  async function chenAsked(folder: string) {
    const { Directory, Paths } = await import('expo-file-system');
    // Prefs and the env identity live under app-wide keys: each teammate phone starts from none.
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    await asyncStorage.removeItem('authdeck-env-prefs-v1');
    secureStore.__secure.clear();
    const maya = await fakes.rig({ seed: `withdraw-owner-${folder}` });
    const setId = await fakes.createdSet(maya, [{ name: 'API_KEY', value: SECRET }]);
    const store = new DeviceEnvStore(() => new Directory(Paths.document, folder));
    const chen = await fakes.rig({ seed: `withdraw-teammate-${folder}`, store: store as never });
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await chen.engine.sync();
    fakes.ask(chen, fakes.joinKeysRequest(chen.agent, 'jk-w', setId));
    await chen.engine.answer('jk-w', 'approve');
    await chen.engine.confirmOwnerWords(setId, chen.engine.snapshot().ownRequests[0]!.ownerKeyWords);
    const memberId = (await store.loadPrefs()).memberId!;
    assert.equal(memberId, chen.device.deviceId, 'the engine joins as this phone');
    const requestPath = `.authdeck/requests/${memberId}.json`;
    chen.agent.sets.get(setId)!.requests.push({ path: requestPath, text: '{}', commit: 'abc1234' });
    const pins = () => [...secureStore.__secure.keys()].filter((k) => k.startsWith('authdeck_env_pin_'));
    assert.equal(pins().length, 1, 'the pin is anchored while the request stands');
    return { maya, chen, setId, store, requestPath, pins };
  }

  /** The owner's file with Chen added, as the owner would write it after approving him. */
  async function withChen(maya: import('./fakes').Rig, chen: import('./fakes').Rig, setId: string) {
    const { addEnvMember, verifyEnvFile, writeEnvFile } = await import('../../src/envcore');
    const current = verifyEnvFile(maya.agent.sets.get(setId)!.text, null);
    assert.ok(current.ok);
    return writeEnvFile(
      addEnvMember({
        file: current.set.file,
        owner: maya.device,
        dataKeys: { 1: maya.store.keys.get(setId)![1]! },
        time: 7,
        member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
      }),
    );
  }

  it('forgets the request with its pin and anchor, and removes its file from the computer', async () => {
    const { chen, setId, store, requestPath, pins } = await chenAsked('env-withdraw');
    await chen.engine.cancelOwnRequest(setId);
    assert.deepEqual(chen.engine.snapshot().ownRequests, []);
    assert.deepEqual((await store.loadPrefs()).ownRequests, []);
    assert.deepEqual(pins(), []);
    assert.ok(!chen.agent.sets.get(setId)!.requests.some((r) => r.path === requestPath));
  });

  it('a file that later lists this device is not taken', async () => {
    const { maya, chen, setId } = await chenAsked('env-withdraw-later');
    await chen.engine.cancelOwnRequest(setId);
    chen.agent.put(setId, 'acme-api', await withChen(maya, chen, setId));
    await chen.engine.sync();
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'outside');
  });

  it('a withdraw while an adoption waits on the history leaves the set outside', async () => {
    const { maya, chen, setId, requestPath } = await chenAsked('env-withdraw-race');
    chen.agent.put(setId, 'acme-api', await withChen(maya, chen, setId));
    // Hold the first history page until the withdraw has been asked for.
    let reached!: () => void;
    const historyReached = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const request = chen.agent.request.bind(chen.agent);
    chen.agent.request = async (method, params) => {
      if (method === 'env.history.read') {
        reached();
        await held;
      }
      return request(method, params);
    };
    const syncing = chen.engine.sync();
    await historyReached;
    const withdrawing = chen.engine.cancelOwnRequest(setId);
    release();
    await Promise.all([syncing, withdrawing]);
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'outside');
    assert.deepEqual(chen.engine.snapshot().ownRequests, []);
    assert.ok(!chen.agent.sets.get(setId)!.requests.some((r) => r.path === requestPath));
  });

  it('offline, it still forgets the request here and resolves; the file stays for the owner', async () => {
    const { maya, chen, setId, store, requestPath, pins } = await chenAsked('env-withdraw-offline');
    await chen.engine.computerChanged(null);
    await chen.engine.cancelOwnRequest(setId);
    assert.deepEqual((await store.loadPrefs()).ownRequests, []);
    assert.deepEqual(pins(), []);
    assert.ok(chen.agent.sets.get(setId)!.requests.some((r) => r.path === requestPath));

    chen.agent.put(setId, 'acme-api', await withChen(maya, chen, setId));
    await chen.engine.computerChanged(fakes.COMPUTER);
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'outside');
  });
});
