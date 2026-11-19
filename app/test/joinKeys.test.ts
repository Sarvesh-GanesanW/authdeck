/**
 * A join that got stuck (squatted, intercepted, or with no usable approval) retires this device's
 * keys: the next attempt, and a join after a removal or an iOS reinstall, uses new ones.
 * Secrets are never printed: keys are compared by device id only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JoinController, JoinIntercepted, JoinNotApproved, type JoinHost } from '../src/auth/engine/join';
import { keysUnlessRetired, renewDeviceKeys, type DeviceKeyStore } from '../src/auth/engine/joinKeys';
import { isRemoved } from '../src/auth/engine/removed';
import type { JoinState } from '../src/auth/contract';
import { buildDeviceAdd, buildDeviceHello, buildDeviceRemove } from '../src/vault/build';
import { createJoinChallenge } from '../src/vault/approval';
import { deviceIdFor, type DeviceKeys } from '../src/vault/crypto';
import { fromBase64Url } from '../src/vault/bytes';
import { MemoryVault, device, seededRandom } from './helpers';

const random = seededRandom('join-keys-tests');
const REQUEST_ID = 'r1';
const FIVE_MINUTES = 5 * 60_000;
/** A well-formed vault id for the approver's challenge. */
const VAULT_ID = new MemoryVault(device(random), random).vaultId;

type MemoryStore = DeviceKeyStore & { stored: DeviceKeys | null; saves: number };

function memoryStore(stored: DeviceKeys | null = null): MemoryStore {
  const store: MemoryStore = {
    stored,
    saves: 0,
    load: async () => store.stored,
    save: async (keys) => {
      store.stored = keys;
      store.saves++;
    },
    make: () => device(random),
  };
  return store;
}

/** Waits for the controller's event handlers, which run as floating promises. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A new device's controller over an in-memory key store; `adopt` decides how the vault check ends. */
function newDevice(adopt: JoinHost['adoptVault'], renew: () => Promise<void> = async () => undefined) {
  const store = memoryStore();
  const sentKeys: string[] = [];
  let view: JoinState | null = null;
  let renewals = 0;
  const host: JoinHost = {
    random,
    now: () => 1_000_000,
    request: (async (method: string, params: { request?: { ed: string } }) => {
      if (method !== 'vault.join.request') return {};
      sentKeys.push(deviceIdFor(fromBase64Url(params.request!.ed)));
      return { requestId: REQUEST_ID, expiresAt: 1_000_000 + FIVE_MINUTES };
    }) as JoinHost['request'],
    keysForJoin: () => keysUnlessRetired(store, () => false),
    renewJoinKeys: async () => {
      renewals++;
      await renew();
      await renewDeviceKeys(store);
    },
    adoptVault: adopt,
    canApprove: () => false,
    approverOffer: async () => {
      throw new Error('not used');
    },
    addDevice: async () => 'vault',
    publish: (published) => {
      view = published.join;
    },
  };
  const joins = new JoinController(host);
  /** Asks to join, has an approver answer, and has it say it finished. */
  const runJoin = async () => {
    await joins.requestJoin('Pixel 8');
    const { challenge } = createJoinChallenge(device(random), { vaultId: VAULT_ID, vaultName: 'Home', deviceName: 'Phone' }, random);
    joins.handleEvent('vault.join.challenged', { requestId: REQUEST_ID, challenge });
    await settle();
    joins.handleEvent('vault.join.finished', { requestId: REQUEST_ID, approved: true, vaultId: VAULT_ID });
    await settle();
  };
  return { joins, store, sentKeys, runJoin, view: () => view, renewals: () => renewals };
}

describe('keys for a new membership', () => {
  it('makes new keys when a vault lists the stored ones as removed (an iPhone reinstalled after removal)', async () => {
    const vault = new MemoryVault(device(random), random);
    const phone = device(random);
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: phone, role: 'admin', name: 'iPhone', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), phone, vault.now()));
    vault.write(buildDeviceRemove(vault.state(), vault.founder, { device: phone.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.equal(isRemoved(state, phone.deviceId), true);

    const store = memoryStore(phone);
    const keys = await keysUnlessRetired(store, (id) => isRemoved(state, id));
    assert.notEqual(keys.deviceId, phone.deviceId);
    assert.equal(store.stored?.deviceId, keys.deviceId, 'the new keys are stored the way device keys are');
    assert.equal(state.members[keys.deviceId], undefined, 'the vault knows nothing of the new keys');
  });

  it('keeps the stored keys when no vault removed them, and makes keys on first use', async () => {
    const kept = device(random);
    const store = memoryStore(kept);
    assert.equal((await keysUnlessRetired(store, () => false)).deviceId, kept.deviceId);
    assert.equal(store.saves, 0);

    const empty = memoryStore();
    const made = await keysUnlessRetired(empty, () => {
      throw new Error('no stored keys, so nothing to check');
    });
    assert.equal(empty.stored?.deviceId, made.deviceId);
  });
});

describe('a stuck join', () => {
  it('makes new keys after an intercepted join, so the next attempt does not offer the squatted ones', async () => {
    const d = newDevice(async () => {
      throw new JoinIntercepted('Something between the two devices changed the join: the vault lists this device with keys it did not send.');
    });
    try {
      await d.runJoin();
      const view = d.view();
      assert.equal(view?.stage, 'failed');
      assert.equal(view?.stuck, 'intercepted');
      assert.equal(d.renewals(), 1);
      assert.notEqual(d.store.stored?.deviceId, d.sentKeys[0]);

      await d.joins.requestJoin('Pixel 8');
      assert.equal(d.sentKeys.length, 2);
      assert.notEqual(d.sentKeys[1], d.sentKeys[0], 'the retry asks with new keys');
      assert.equal(d.sentKeys[1], d.store.stored?.deviceId);
      assert.equal(d.renewals(), 1, 'keys are renewed once per stuck join');
    } finally {
      d.joins.dispose();
    }
  });

  it('a squatter\'s approval names the old device id, which the new keys never match', async () => {
    const vault = new MemoryVault(device(random), random);
    const squatter = device(random);
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: squatter, role: 'admin', name: 'Laptop', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), squatter, vault.now()));
    const joiner = device(random);
    const squat = { deviceId: joiner.deviceId, edPublic: joiner.edPublic, xPublic: squatter.xPublic };
    vault.write(buildDeviceAdd(vault.state(), squatter, { device: squat, role: 'admin', name: 'Pixel 8', currentKey: vault.key, random, time: vault.now() }));
    assert.ok(vault.state().members[joiner.deviceId], 'the squatted add lists the joiner');

    const store = memoryStore(joiner);
    const renewed = await renewDeviceKeys(store);
    assert.equal(vault.state().members[renewed.deviceId], undefined);
    assert.equal(store.stored?.deviceId, renewed.deviceId);
  });

  it('explains a join with no usable approval, and cancelling forgets it and leaves new keys for the next attempt', async () => {
    const d = newDevice(async () => {
      throw new JoinNotApproved("The other device said it approved this one, but the vault folder on the computer doesn't list this device.");
    });
    try {
      await d.runJoin();
      assert.equal(d.view()?.stuck, 'unapproved');
      assert.match(d.view()?.error ?? '', /doesn't list this device/);

      d.joins.cancel();
      assert.equal(d.view(), null, 'the pending join is forgotten');
      assert.notEqual(d.store.stored?.deviceId, d.sentKeys[0]);

      await d.joins.requestJoin('Pixel 8');
      assert.notEqual(d.sentKeys[1], d.sentKeys[0]);
    } finally {
      d.joins.dispose();
    }
  });

  it('when making new keys fails, the next attempt makes them before asking', async () => {
    let fail = true;
    const d = newDevice(
      async () => {
        throw new JoinIntercepted('intercepted');
      },
      async () => {
        if (fail) throw new Error('secure storage is busy');
      },
    );
    try {
      await d.runJoin();
      assert.equal(d.view()?.stuck, 'intercepted');
      assert.equal(d.store.stored?.deviceId, d.sentKeys[0], 'the renewal failed, so the old keys are still stored');

      fail = false;
      d.joins.cancel();
      await d.joins.requestJoin('Pixel 8');
      assert.equal(d.renewals(), 2);
      assert.notEqual(d.sentKeys[1], d.sentKeys[0]);
    } finally {
      d.joins.dispose();
    }
  });

  it('a plain failure keeps the keys', async () => {
    const d = newDevice(async () => {
      throw new Error('The computer went offline.');
    });
    try {
      await d.runJoin();
      assert.equal(d.view()?.stage, 'failed');
      assert.equal(d.view()?.error, 'The computer went offline.');
      assert.equal(d.view()?.stuck, undefined);
      assert.equal(d.renewals(), 0);
      await d.joins.requestJoin('Pixel 8');
      assert.equal(d.sentKeys[1], d.sentKeys[0]);
    } finally {
      d.joins.dispose();
    }
  });
});
