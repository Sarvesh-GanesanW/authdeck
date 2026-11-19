/**
 * "I don't have my phrase" (replaceVault.ts): a new solo vault with every account, then the old
 * one retired. Each test stops the run at one point and starts it again, as a restart would, and
 * checks the old vault is never touched before the new one reads back, and that this device
 * always has a vault that opens.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newAccountId } from '../src/vault/build';
import type { DeviceKeys } from '../src/vault/crypto';
import { openVault, type AccountRecord, type OpenAccount } from '../src/vault/open';
import { recoveryKeysFromPhrase } from '../src/vault/recovery';
import { replayVault } from '../src/vault/replay';
import { buildReplacement, finishReplacement, NOT_READ_BACK, type ReplaceSteps, type VaultReplacement } from '../src/auth/engine/replaceVault';
import { device, seededRandom, totpRecord } from './helpers';

const OLD = 'oldvault0000000000000a';
const replay = (vaultId: string, logs: Record<string, string[]>) => replayVault(vaultId, logs);
const account = (id: string, record: AccountRecord): OpenAccount => ({ id, record, author: 'x', time: 1 });

/** Every way a step can stop the run: the step named throws once, as a stop or a lost link would. */
type Step = 'send' | 'read' | 'adopt' | 'retireOnComputer' | 'forgetLocal' | 'save' | 'saveLines';

/** This device and the computer, in memory. */
class World {
  readonly random = seededRandom('replace');
  readonly phone: DeviceKeys = device(this.random);
  /** The computer's folders: vault id to device logs. */
  readonly computer = new Map<string, Record<string, string[]>>([[OLD, { old: ['line'] }]]);
  /** This device's local copies: vault id to its own lines (the old one just needs to exist). */
  readonly local = new Map<string, string[]>([[OLD, ['old line']]]);
  current: string | null = OLD;
  record: VaultReplacement | null = null;
  locked = false;
  accounts: OpenAccount[];
  stopAt: Step | null = null;
  /** Every line ever sent per vault and seq, to catch two different lines at one seq. */
  readonly sentAt = new Map<string, string>();
  deletes: string[] = [];
  /** The computer connected now. */
  agent: string | null = 'laptop';

  constructor(accounts: OpenAccount[]) {
    this.accounts = accounts;
  }

  private stop(step: Step): void {
    if (this.stopAt === step) {
      this.stopAt = null;
      throw new Error(`stopped at ${step}`);
    }
  }

  steps(): ReplaceSteps {
    return {
      current: () => this.current,
      agentId: () => this.agent,
      openOld: () => (this.locked ? null : { device: this.phone, accounts: this.accounts }),
      loadLines: async (id) => [...(this.local.get(id) ?? [])],
      saveLines: async (id, lines) => {
        this.stop('saveLines');
        this.local.set(id, [...lines]);
      },
      send: async (id, lines) => {
        this.stop('send');
        const folder = this.computer.get(id) ?? {};
        const log = (folder[this.phone.deviceId] ??= []);
        lines.forEach((line, seq) => {
          const key = `${id}/${seq}`;
          const before = this.sentAt.get(key);
          assert.ok(before === undefined || before === line, `two different lines sent at seq ${seq}`);
          this.sentAt.set(key, line);
          if (seq >= log.length) log.push(line);
        });
        this.computer.set(id, folder);
      },
      read: async (id) => {
        this.stop('read');
        const folder = this.computer.get(id) ?? {};
        return Object.fromEntries(Object.entries(folder).map(([d, lines]) => [d, [...lines]]));
      },
      replay,
      adopt: async (id) => {
        this.stop('adopt');
        this.current = id;
      },
      retireOnComputer: async (id) => {
        this.stop('retireOnComputer');
        this.deletes.push(id);
        this.computer.delete(id);
      },
      forgetLocal: async (id) => {
        this.stop('forgetLocal');
        this.local.delete(id);
      },
      save: async (record) => {
        this.stop('save');
        this.record = record;
      },
      random: this.random,
      now: () => 2_000_000,
    };
  }

  /** Builds the new vault and stores it as the engine does once the new words are checked. */
  begin(): { record: VaultReplacement; phrase: string[] } {
    const built = buildReplacement({ device: this.phone, name: 'Home', deviceName: 'Phone', accounts: this.accounts, random: this.random, time: 1_500_000, replay });
    this.local.set(built.vaultId, built.lines);
    this.record = { oldVaultId: OLD, newVaultId: built.vaultId, agentId: 'laptop' };
    return { record: this.record, phrase: built.phrase };
  }

  /** A restart: runs again from the stored record, as the engine does on start and every sync. */
  async resume(): Promise<'done' | 'waiting' | 'none'> {
    if (!this.record) return 'none';
    return finishReplacement(this.record, this.steps());
  }

  /** The new vault as the computer holds it, opened with the phone's keys. */
  openNew(id: string): Record<string, OpenAccount> {
    const state = replay(id, this.computer.get(id)!);
    return openVault(state, this.phone).accounts;
  }

  /** A vault this device can open: the one it uses has a local copy. */
  assertOpenable(): void {
    assert.ok(this.current !== null && (this.local.get(this.current)?.length ?? 0) > 0, 'this device has no vault that opens');
  }
}

function sampleAccounts(random = seededRandom('accounts')): OpenAccount[] {
  return [
    account(newAccountId(random), totpRecord({ issuer: 'GitHub', label: 'ada', icon: 'github', position: 0 })),
    account(newAccountId(random), totpRecord({ issuer: 'Google', label: 'ada@example.com', icon: 'google', position: 1, digits: 8 })),
    account(newAccountId(random), totpRecord({ issuer: '', label: 'Bank', position: 2, type: 'hotp', counter: 7 })),
  ];
}

function assertSameAccounts(got: Record<string, OpenAccount>, want: OpenAccount[]): void {
  assert.deepEqual(
    Object.fromEntries(Object.entries(got).map(([id, a]) => [id, a.record])),
    Object.fromEntries(want.map((a) => [a.id, a.record])),
  );
}

async function runToEnd(world: World): Promise<void> {
  for (let i = 0; i < 10 && world.record; i++) {
    try {
      await world.resume();
    } catch {
      // A stop: try again, as the next start would.
    }
    world.assertOpenable();
  }
  assert.equal(world.record, null, 'the replacement never finished');
}

describe('replacing a solo vault without its phrase', () => {
  it('makes a solo vault with every account (labels, icons, order) and a phrase that is its recovery identity', () => {
    const world = new World(sampleAccounts());
    const { record, phrase } = world.begin();
    const lines = world.local.get(record.newVaultId)!;
    const state = replay(record.newVaultId, { [world.phone.deviceId]: lines });
    assert.equal(state.kind, 'solo');
    assert.equal(state.rejected.length, 0);
    assert.equal(state.recovery?.deviceId, recoveryKeysFromPhrase(phrase.join(' '), record.newVaultId).deviceId);
    assertSameAccounts(openVault(state, world.phone).accounts, world.accounts);
    // Built only: nothing went to the computer and the old vault is as it was.
    assert.deepEqual([...world.computer.keys()], [OLD]);
    assert.deepEqual(world.local.get(OLD), ['old line']);
  });

  it('runs straight through: new vault saved and read back, then the old one deleted there and here', async () => {
    const world = new World(sampleAccounts());
    const { record } = world.begin();
    assert.equal(await world.resume(), 'done');
    assert.equal(world.current, record.newVaultId);
    assertSameAccounts(world.openNew(record.newVaultId), world.accounts);
    assert.deepEqual(world.deletes, [OLD]);
    assert.equal(world.local.has(OLD), false);
    assert.equal(world.record, null);
  });

  for (const step of ['send', 'read', 'adopt', 'retireOnComputer', 'forgetLocal', 'save'] as const) {
    it(`finishes after a stop at ${step}, keeping a vault that opens throughout`, async () => {
      const world = new World(sampleAccounts());
      const { record } = world.begin();
      world.stopAt = step;
      await assert.rejects(world.resume(), new RegExp(`stopped at ${step}`));
      world.assertOpenable();
      // Before the switch nothing of the old vault is touched.
      if (step === 'send' || step === 'read' || step === 'adopt') {
        assert.equal(world.current, OLD);
        assert.deepEqual(world.deletes, []);
        assert.deepEqual(world.local.get(OLD), ['old line']);
      } else {
        assert.equal(world.current, record.newVaultId);
      }
      assert.deepEqual(world.record, record, 'the record stays until the old vault is retired');
      await runToEnd(world);
      assert.equal(world.current, record.newVaultId);
      assertSameAccounts(world.openNew(record.newVaultId), world.accounts);
      assert.equal(world.computer.has(OLD), false);
      assert.equal(world.local.has(OLD), false);
    });
  }

  it('never deletes the old vault when the new folder does not read back as sent', async () => {
    const world = new World(sampleAccounts());
    const { record } = world.begin();
    const steps = world.steps();
    // A computer that drops the last line.
    const lossy: ReplaceSteps = {
      ...steps,
      read: async (id) => {
        const logs = await steps.read(id);
        logs[world.phone.deviceId] = logs[world.phone.deviceId]!.slice(0, -1);
        return logs;
      },
    };
    await assert.rejects(finishReplacement(record, lossy), (err: Error) => err.message === NOT_READ_BACK);
    assert.equal(world.current, OLD);
    assert.deepEqual(world.deletes, []);
    assert.deepEqual(world.local.get(OLD), ['old line']);
    assert.deepEqual(world.record, record);
  });

  it('copies changes the old vault took after the words were checked, resending the same bytes after a stop', async () => {
    const random = seededRandom('changes');
    const world = new World(sampleAccounts(random));
    const { record } = world.begin();
    // Before the run: one account renamed, one deleted, one added on the old vault.
    const [first, , third] = world.accounts;
    world.accounts = [account(first!.id, { ...first!.record, label: 'ada (work)' }), third!, account(newAccountId(random), totpRecord({ issuer: 'Fastmail', position: 3 }))];
    // Stop once the top-up lines are kept, before they go.
    const steps = world.steps();
    let sends = 0;
    const stopping: ReplaceSteps = {
      ...steps,
      send: async (id, lines) => {
        if (++sends === 2) throw new Error('stopped before the top-up went');
        return steps.send(id, lines);
      },
    };
    await assert.rejects(finishReplacement(record, stopping), /top-up/);
    assert.equal(world.current, OLD);
    await runToEnd(world);
    assertSameAccounts(world.openNew(record.newVaultId), world.accounts);
  });

  it('finishes only on the computer the words were confirmed with', async () => {
    const world = new World(sampleAccounts());
    const { record } = world.begin();
    world.agent = 'other-computer';
    assert.equal(await world.resume(), 'waiting');
    assert.equal(world.computer.has(record.newVaultId), false);
    world.stopAt = 'retireOnComputer';
    world.agent = 'laptop';
    await assert.rejects(world.resume(), /stopped at retireOnComputer/);
    // Switched, and the retire is still to do: another computer never gets it.
    world.agent = 'other-computer';
    assert.equal(await world.resume(), 'waiting');
    assert.deepEqual(world.deletes, []);
    world.agent = null;
    assert.equal(await world.resume(), 'waiting');
    world.agent = 'laptop';
    await runToEnd(world);
    assert.deepEqual(world.deletes, [OLD]);
  });

  it('waits while the old vault is locked, and does nothing', async () => {
    const world = new World(sampleAccounts());
    const { record } = world.begin();
    world.locked = true;
    assert.equal(await world.resume(), 'waiting');
    assert.equal(world.computer.has(record.newVaultId), false);
    assert.deepEqual(world.record, record);
    world.locked = false;
    await runToEnd(world);
  });

  it('deletes nothing when this device uses neither vault any more', async () => {
    const world = new World(sampleAccounts());
    world.begin();
    world.current = null;
    assert.equal(await world.resume(), 'done');
    assert.deepEqual(world.deletes, []);
    assert.equal(world.local.has(OLD), true);
    assert.equal(world.record, null);
  });

  it('a stop before the record is stored leaves the old vault as it was and sends nothing', () => {
    // The engine stores the new lines, then the record; the run starts only after both.
    const world = new World(sampleAccounts());
    world.begin();
    world.record = null;
    assert.deepEqual([...world.computer.keys()], [OLD]);
    assert.equal(world.current, OLD);
    world.assertOpenable();
  });
});
