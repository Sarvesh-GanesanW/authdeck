// Review-7 engine fixes, each scenario in its own process (test/engine/scenarios.mts): the real
// engine against a computer backed by the real agent VaultStore.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const APP = path.dirname(__dirname);
function run(name: string): Record<string, any> {
  const out = execFileSync(process.execPath, ['--import', 'tsx', path.join(APP, 'test/engine/scenarios.mts'), name], { cwd: APP, encoding: 'utf8', timeout: 120_000 });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result from ${name}`);
  return JSON.parse(line.slice('RESULT '.length));
}
const PENDING = "Your last phrase change hasn't reached the computer yet. Keep the words you wrote down for it. AuthDeck finishes it when the computer is reachable.";
const STALE = /out of date/;

describe('recovery flows end cleanly (A6)', () => {
  it('stop a replacement, then a normal phrase change: only the change happens', () => {
    const r = run('stop-then-normal');
    assert.deepEqual(r.confirm, { saved: true });
    assert.deepEqual(r.vaults, [{ same: true, retired: false }]);
    assert.equal(r.recoveryIsNew, true);
    assert.equal(r.retires, 0);
  });
  it('stop a replacement, then replace again: only the second one counts', () => {
    const r = run('stop-then-replace-again');
    assert.match(r.staleConfirm, STALE);
    assert.deepEqual(r.confirm, { saved: true });
    assert.equal(r.live, 1);
    assert.equal(r.oldRetired, true);
    assert.equal(r.newPhraseIsSecond, true);
    assert.equal(r.accounts, 1);
  });
  it('replace, stop, reopen: the old token confirms nothing and the vault stays', () => {
    const r = run('replace-stop-reopen');
    assert.match(r.staleConfirm, STALE);
    assert.deepEqual(r.vaults, [{ same: true, retired: false }]);
    assert.equal(r.retires, 0);
  });
  it('"Check words" with nothing made is an error, never saved (A2)', () => {
    assert.match(run('check-with-nothing').noFlow, STALE);
  });
});

describe('a solo phrase change on its way (A1.1, A3)', () => {
  it('a refused change is kept and resent as the same line, and blocks another until it applies', () => {
    const r = run('refused-phrase-change');
    assert.deepEqual(r.first, { saved: false });
    assert.deepEqual(r.second, { saved: false });
    assert.equal(r.pendingShown, true);
    assert.equal(r.another, `error: ${PENDING}`);
    assert.equal(r.replace, `error: ${PENDING}`);
    assert.equal(r.distinctLines, 1);
    assert.equal(r.applied, true);
    assert.equal(r.pendingAfter, false);
    assert.equal(r.savedAtSet, true);
  });
  it('a dropped change leaves the saved date, opens with either phrase until it applies, then only the new one', () => {
    const r = run('dropped-phrase-change');
    assert.deepEqual(r.confirm, { saved: false });
    assert.equal(r.savedAtMoved, false);
    assert.equal(r.pendingShown, true);
    assert.equal(r.unlockNew, 'ok');
    assert.equal(r.unlockOld, 'ok');
    assert.equal(r.applied, true);
    assert.equal(r.savedAtMovedAfter, true);
    assert.match(r.unlockOldAfter, /not this vault's current recovery phrase/);
  });
});

describe('replacing a vault retires the old one (B1)', () => {
  it('signed for this computer, kept 30 days, and its old phrase still restores it', () => {
    const r = run('replace-retires');
    assert.deepEqual(r.confirm, { saved: true });
    assert.equal(r.oldKept, true);
    assert.equal(r.keptDays, 30);
    assert.equal(r.oldPhraseStillOpens, true);
    assert.equal(r.retireSigned, true);
  });
});

describe('solo vaults hold no seal proofs', () => {
  it('keeps and shares none, even ones the computer serves', () => {
    const r = run('solo-no-seal-proofs');
    assert.equal(r.kept, 0);
    assert.equal(r.sealWrites, 0);
    assert.equal(r.accounts, 2);
  });
});

describe('a phrase change the computer swapped for another version (A1.2)', () => {
  it("still counts: the active device built on it at once, so the old phrase's version loses", () => {
    const r = run('phrase-change-lost');
    assert.deepEqual(r.confirm, { saved: false });
    assert.equal(r.oursCounts, true);
    assert.equal(r.otherCounts, false);
    assert.equal(r.pending, false);
    assert.deepEqual(r.toasts, []);
    assert.deepEqual(r.next, { saved: true });
    assert.equal(r.warnings, 0);
  });
});

describe('a thief\'s deletes before a restore are offered back (P3)', () => {
  for (const name of ['restore-after-thief-deletes', 'restore-after-thief-deletes-clock']) {
    it(`${name}: offers every delete (by seq, never the thief\'s clock) and recent edits, and bringing them back restores the accounts and their secrets`, () => {
      const r = run(name);
      assert.deepEqual(r.restored, { replacedAt: null, warning: null });
      // Newest first by seq; every delete whatever its age; Edit as it was before the rename; Shop's rename is past the last 50 lines.
      assert.deepEqual(r.offered, ['restore:Bring back Edit (owner)', 'restore:Bring back Mail (owner)', 'restore:Bring back Bank (owner)']);
      assert.equal(r.accountsBefore, 56);
      assert.equal(r.bringBack, 'ok');
      assert.deepEqual(r.after, r.before.map((a: { issuer: string; label: string }) => (a.issuer === 'Shop' ? { ...a, label: 'thief' } : a)));
      assert.equal(r.mailSecretBack, true);
      assert.equal(r.offeredAfter, 0);
    });
  }
});

describe('a damaged pending phrase-change record', () => {
  it('is told once, the change this device acked still reaches the folder, and a new phrase can be made', () => {
    const r = run('damaged-phrase-change');
    assert.equal(r.damagedKeys, 1);
    assert.equal(r.told, 1);
    assert.equal(r.pending, false);
    assert.equal(r.applied, true);
    assert.deepEqual(r.next, { saved: true });
  });
});

describe('a kept restore attempt written in around the adopted restore (A1.2 rule 3, P1b)', () => {
  it('before the ack lands: the engine sees its restore lost and signs it again on top of the winner', () => {
    const r = run('restore-flip-before-ack');
    assert.deepEqual(r.restored, { replacedAt: null, warning: null });
    assert.equal(r.flipped, true);
    assert.equal(r.keptAttemptIn, false);
    assert.equal(r.thisDeviceIn, true);
    assert.equal(r.add, 'ok');
    assert.equal(r.accounts, 2);
  });

  it('after the ack lands: the kept attempt loses', () => {
    const r = run('restore-flip-after-ack');
    assert.equal(r.ackInFolder, true);
    assert.equal(r.flipped, true);
    assert.equal(r.keptAttemptIn, false);
    assert.equal(r.thisDeviceIn, true);
    assert.equal(r.add, 'ok');
    assert.equal(r.accounts, 2);
  });
});

describe('review 9: the phrase never signs on an older copy, and a restore never fools the phone', () => {
  it('Q1: no new phrase on a rewound folder; it works once the computer catches up', () => {
    const r = run('phrase-change-rewound');
    assert.equal(r.refused, 'error: This computer is showing an older copy of your vault. Try again once it has caught up.');
    assert.equal(r.rSigned, false);
    assert.equal(r.afterCatchUp, 'made');
  });

  it('Q4: the old phrase plus the phone\'s key can\'t outvote the owner\'s acked phrase change', () => {
    const r = run('old-phrase-plus-phone-key');
    assert.match(r.honestRefused, /^error: A device in this vault already built on/);
    assert.equal(r.ground, true);
    assert.equal(r.ownerPhraseStands, true);
    assert.equal(r.ownerRestores, true);
  });

  it('Q2: a folder that lacks the restore gets a warning and the same bytes again, never a second restore', () => {
    const r = run('restore-rewound');
    assert.equal(r.recordsLeft, 0);
    assert.equal(r.attemptKeysLeft, 0);
    assert.equal(r.warned, true);
    assert.equal(r.rollbackShown, true);
    assert.equal(r.addsAtR, 1);
    assert.equal(r.add, 'ok');
    assert.equal(r.liveMembers, 1);
    assert.equal(r.accounts, 2);
  });

  it('Q2: when the computer counts an earlier attempt of this phone, the phone adopts it with its kept keys', () => {
    const r = run('restore-adopts-earlier');
    assert.deepEqual(r.restored, { replacedAt: null, warning: null });
    assert.equal(r.firstAttemptIn, true);
    assert.equal(r.thisDeviceIsFirst, true);
    assert.equal(r.add, 'ok');
    assert.equal(r.accounts, 2);
  });

  it('Q7: a phone whose restore lost to an earlier one says so, and restoring again takes that phone out', () => {
    const r = run('restore-lost-to-earlier');
    assert.equal(r.toldPlainly, true);
    assert.equal(r.deleted, 'ok');
    assert.deepEqual(r.restoredAgain, { replacedAt: null, warning: null });
    assert.equal(r.bOut, true);
    assert.equal(r.cIn, true);
    assert.equal(r.add, 'ok');
  });
});

describe('review 10', () => {
  it('N1: the honest agent refuses an old phrase\'s version at a line P built on; under a hostile computer P says why, locked too (L2, L3)', () => {
    const r = run('old-phrase-forks-restore-add');
    assert.match(r.honestRefused, /^error: A device in this vault already built on the recovery phrase's line/);
    assert.equal(r.honestKeepsOwner, true);
    assert.equal(r.toldOpen, true);
    assert.equal(r.toldLocked, true);
    assert.match(r.unlock, /^error: Your recovery phrase was changed from another copy of your phrase/);
  });
});

describe('round 11: the restore search', () => {
  it('finds the vault this phrase restores among several, after a phrase change too; the old phrase finds none', () => {
    const r = run('restore-among-vaults');
    assert.equal(r.vaults, 4);
    assert.match(r.oldPhrase, /^error: No vault on/);
    assert.equal(r.newPhrase, 'restored');
    assert.equal(r.rightVault, true);
  });
});

describe('integration pass 3', () => {
  it('an interrupted "I don\'t have my phrase" shows as finishing and completes on unlock', () => {
    const r = run('replacement-resumes-on-unlock');
    assert.match(r.firstTry, /^error:/);
    assert.equal(r.finishingShown, true);
    assert.equal(r.stillPending, true);
    assert.equal(r.finishedAfterUnlock, true);
    assert.deepEqual(r.vaults, [{ same: false, retired: false }, { same: true, retired: true }]);
  });

  it('a vault whose phrase was never checked is marked so Backup offers to set one up', () => {
    const r = run('never-set-phrase');
    assert.equal(r.neverSet, true);
    assert.equal(r.afterCheck, false);
  });
});
