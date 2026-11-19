// Changes made on the phone and what it accepts from the computer: edits with conflict retry,
// offline edits merged later, trust updates and rollback refusal, tampered files, bad wraps,
// history, and a revealed value that hides again.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { changeEnvValues, newEnvTransferKey, openEnvSealedValues, signEnvHeader, verifyEnvFile, writeEnvFile, type EnvSetFile } from '../../src/envcore';
import { ENV_REVEAL_MS } from '../../src/auth/envContract';
import { MAX_WRITE_ATTEMPTS } from '../../src/auth/env/engine';
import { RevealTimer, type RevealClock } from '../../src/screens/env/reveal';
import { generateDeviceKeys, sealKey } from '../../src/vault/crypto';
import { COMPUTER, ask, createdSet, disposeAll, externalSet, releaseRequest, rig, settle, joinedThrough } from './fakes';

afterEach(disposeAll);

function fileOf(text: string): EnvSetFile {
  const verified = verifyEnvFile(text, null);
  if (!verified.ok) throw new Error(`refused: ${verified.problem.kind}`);
  return verified.set.file;
}

describe('edits on the phone', () => {
  it('add, change, rename and delete sign a new line each and write the file', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    await r.engine.saveVariable(setId, { name: 'NEW_ONE', value: 'n1' });
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'sk_live_2' });
    await r.engine.saveVariable(setId, { name: 'DATABASE_URL', value: 'postgres://db2', previousName: 'DB_URL' });
    await r.engine.deleteVariable(setId, 'NEW_ONE');
    const onComputer = fileOf(r.agent.sets.get(setId)!.text);
    const live = onComputer.values.filter((v) => v.box !== null).map((v) => `${v.name}@${v.version}`);
    assert.deepEqual(live.sort(), ['API_KEY@2', 'DATABASE_URL@1']);
    assert.equal(await r.engine.reveal(setId, 'DATABASE_URL'), 'postgres://db2');
    assert.deepEqual(r.engine.detail(setId)!.variables.map((v) => v.by), ['Maya', 'Maya']);
  });

  it('refuses a bad name or a value over the cap before signing anything', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    await assert.rejects(r.engine.saveVariable(setId, { name: '1BAD', value: 'x' }), /can't be a variable name/);
    assert.deepEqual(r.engine.checkVariable('OK_NAME', 'x'), []);
    assert.equal(r.engine.parseDotenv('A=1\n# c\nexport B="two\\nlines"\nnope\nA=3').values.length, 2);
  });

  it('a conflict reads the file again and re-applies the change on top', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    let conflicts = 0;
    r.agent.beforeWrite = (set) => {
      if (conflicts++ > 0) return;
      // Another of this person's devices (here: the same keys) changed DB_URL meanwhile.
      const current = fileOf(set.text);
      const changed = changeEnvValues({
        file: current,
        author: r.device,
        dataKey: r.store.keys.get(setId)![current.header.epoch]!,
        changes: { upsert: [{ name: 'DB_URL', value: 'postgres://other' }], remove: [] },
        time: 5,
        random: r.random,
      });
      r.agent.put(setId, set.name, writeEnvFile(changed.file));
    };
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'sk_live_3' });
    assert.equal(conflicts, 2);
    assert.equal(await r.engine.reveal(setId, 'API_KEY'), 'sk_live_3');
    assert.equal(await r.engine.reveal(setId, 'DB_URL'), 'postgres://other');
    const written = fileOf(r.agent.sets.get(setId)!.text);
    assert.equal(written.values.find((v) => v.name === 'DB_URL')!.version, 2);
  });

  it('gives up with a plain sentence when the file keeps changing', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    let writes = 0;
    r.agent.beforeWrite = (set) => {
      writes++;
      set.text = `${set.text}`;
      r.agent.put(setId, set.name, set.text.replace('\n', '\n\n'));
    };
    await assert.rejects(r.engine.saveVariable(setId, { name: 'API_KEY', value: 'x' }), /kept changing/);
    assert.equal(writes, MAX_WRITE_ATTEMPTS);
  });

  it('offline, a change waits on the phone and is merged and written when the computer is back', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    await r.engine.computerChanged(null);
    assert.equal(r.engine.snapshot().sets[0]!.problems.some((p) => p.kind === 'offline'), true);
    await r.engine.saveVariable(setId, { name: 'OFFLINE_ONE', value: 'o1' });
    assert.equal(r.store.sets.get(setId)!.pending, true);
    assert.ok(!r.agent.sets.get(setId)!.text.includes('OFFLINE_ONE'));

    await r.engine.computerChanged(COMPUTER);
    assert.ok(fileOf(r.agent.sets.get(setId)!.text).values.some((v) => v.name === 'OFFLINE_ONE'));
    assert.equal(r.store.sets.get(setId)!.pending, false);
  });
});

describe('trust and rollback', () => {
  it('remembers the newest file and answers an older one from its own copy', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const old = r.agent.sets.get(setId)!.text;
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'sk_new' });
    assert.equal(r.store.sets.get(setId)!.trust.head.versions.API_KEY, 2);

    // The computer goes back to the older file (a reverted commit, or someone hiding the change).
    r.agent.put(setId, 'acme-api', old);
    await r.engine.sync();
    const view = r.engine.snapshot().sets[0]!;
    assert.ok(view.problems.some((p) => p.kind === 'older-copy'));
    // The computer's checkout is left as it is.
    assert.equal(r.agent.sets.get(setId)!.text, old);

    const oneTime = newEnvTransferKey(r.random);
    ask(r, releaseRequest(r.agent, 'run-1', setId, { oneTime: oneTime.xPublic, grant: oneTime.xPublic }, old));
    assert.equal(r.engine.snapshot().incoming[0]!.olderOnComputer, true);
    await r.engine.answer('run-1', 'once');
    const answer = r.agent.answers.get('run-1');
    assert.ok(answer?.kind === 'release');
    const values = openEnvSealedValues(answer.values, { set: setId, request: 'run-1' }, oneTime);
    assert.equal(values.find((v) => v.name === 'API_KEY')!.value, 'sk_new');
  });

  it('a newer valid file from the computer is adopted and its trust kept', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const current = fileOf(r.agent.sets.get(setId)!.text);
    const changed = changeEnvValues({
      file: current,
      author: r.device,
      dataKey: r.store.keys.get(setId)![1]!,
      changes: { upsert: [{ name: 'FROM_LAPTOP', value: 'l1' }], remove: [] },
      time: 9,
      random: r.random,
    });
    r.agent.put(setId, 'acme-api', writeEnvFile(changed.file));
    await r.engine.sync();
    assert.equal(r.store.sets.get(setId)!.trust.head.versions.FROM_LAPTOP, 1);
    assert.equal(await r.engine.reveal(setId, 'FROM_LAPTOP'), 'l1');
  });

  it('a tampered file is refused whole: a file problem, and only Deny', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const text = r.agent.sets.get(setId)!.text;
    const tampered = text.replace(/^API_KEY=enc:(\d+):([A-Za-z0-9_-]+)\./m, (_m, e, n) => `API_KEY=enc:${e}:${n.slice(0, -2)}AA.`);
    assert.notEqual(tampered, text);
    r.agent.put(setId, 'acme-api', tampered);
    await r.engine.sync();
    const problems = r.engine.snapshot().sets[0]!.problems;
    assert.ok(problems.some((p) => p.kind === 'file' && p.severity === 'error'), JSON.stringify(problems));

    const keys = newEnvTransferKey(r.random);
    ask(r, releaseRequest(r.agent, 'run-1', setId, { oneTime: keys.xPublic, grant: keys.xPublic }, tampered));
    assert.ok(r.engine.snapshot().incoming[0]!.problem);
    await assert.rejects(r.engine.answer('run-1', 'once'));
    assert.equal(r.agent.answers.has('run-1'), false);
  });

  it('a set whose owner gave another member a different key is refused and releases nothing', async () => {
    const owner = generateDeviceKeys((n) => crypto.getRandomValues(new Uint8Array(n)));
    const other = generateDeviceKeys((n) => crypto.getRandomValues(new Uint8Array(n)));
    const r = await rig({ computer: null });
    const made = externalSet(owner, r.random, { members: [r.device, other] });
    const header = made.file.header;
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    const members = header.members.map((m) =>
      m.id === other.deviceId ? { ...m, key: sealKey(wrongKey, Buffer.from(m.x, 'base64url'), { vault: header.set, epoch: header.epoch, to: m.id }) } : m,
    );
    const { sig: _sig, ...unsigned } = { ...header, members };
    const bad: EnvSetFile = { header: signEnvHeader(unsigned, owner), values: made.file.values };
    const text = writeEnvFile(bad);
    assert.ok(verifyEnvFile(text, null).ok, 'the file itself passes; only the key shows it');
    await joinedThrough(r, made.setId, text);
    assert.equal(r.engine.snapshot().sets[0]!.role, 'member');

    await assert.rejects(r.engine.reveal(made.setId, 'API_KEY'), /doesn't match/);
    assert.ok(r.engine.snapshot().sets[0]!.problems.some((p) => p.id === 'file:bad-wraps'));
    const keys = newEnvTransferKey(r.random);
    ask(r, releaseRequest(r.agent, 'run-1', made.setId, { oneTime: keys.xPublic, grant: keys.xPublic }));
    assert.ok(r.engine.snapshot().incoming[0]!.problem);
    await assert.rejects(r.engine.answer('run-1', 'once'), /doesn't match/);
    assert.equal(r.agent.answers.has('run-1'), false);
  });
});

describe('history', () => {
  it('reads the git log a page at a time, worded from the signatures', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'v2' });
    await r.engine.saveVariable(setId, { name: 'EXTRA', value: 'e' });
    const first = await r.engine.history(setId);
    assert.deepEqual(first.items.map((i) => i.text), ['Added EXTRA', 'Changed API_KEY']);
    assert.equal(first.more, true);
    assert.ok(first.items.every((i) => i.signed && i.by === 'Maya Rao · Pixel 8'));
    const second = await r.engine.history(setId, first.items[1]!.commit);
    assert.deepEqual(second.items.map((i) => i.text), ['Made the set with API_KEY and DB_URL']);
    assert.equal(second.more, false);
  });
});

describe('reveal', () => {
  it('opens one value while the vault is open, and hides again after ENV_REVEAL_MS', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    let at = 0;
    let hide: (() => void) | null = null;
    const clock: RevealClock = {
      now: () => at,
      later: (run, ms) => {
        assert.equal(ms, ENV_REVEAL_MS);
        hide = run;
        return () => (hide = null);
      },
    };
    const shown: (string | null)[] = [];
    const timer = new RevealTimer((value) => shown.push(value?.value ?? null), clock);
    await timer.reveal('API_KEY', () => r.engine.reveal(setId, 'API_KEY'));
    assert.equal(timer.shown?.value, 'sk_live_1');
    at = ENV_REVEAL_MS;
    (hide as (() => void) | null)?.();
    assert.equal(timer.shown, null);
    assert.deepEqual(shown, ['sk_live_1', null]);
    assert.equal(ENV_REVEAL_MS, 30_000);
  });

  it('refuses while the vault is locked, and locking drops the keys', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    r.vault.state = 'locked';
    await r.engine.vaultChanged();
    await assert.rejects(r.engine.reveal(setId, 'API_KEY'), /Unlock/);
    await settle();
  });
});
