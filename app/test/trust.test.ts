import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PairingClaim,
  type PairingRoute,
  type PairingStart,
  type TrustDecision,
  acceptedIdentity,
  cleanName,
  decidePairing,
  isSameComputerName,
  mixesAlphabets,
  nameSkeleton,
} from '../src/net/trust';
import type { Computer } from '../src/state/model';
import { toBase64Url } from '../src/vault/bytes';
import { CONFUSABLE_SAMPLE } from './confusableSample';
import { newLinkKey } from './linkServers';

const SAVED_KEY = toBase64Url(newLinkKey().public);
const OTHER_KEY = toBase64Url(newLinkKey().public);
const SAVED_NAME = 'Ada’s MacBook';

function saved(withKey: boolean): Computer {
  return { agentId: 'ada-mac', name: SAVED_NAME, platform: 'macos', hosts: ['192.168.1.5'], port: 47474, pairedAt: 1, ...(withKey ? { linkKey: SAVED_KEY } : {}) };
}

interface Row {
  startedFrom: PairingStart;
  idMatches: boolean;
  /** The id the network list or typed address gave (from /hello) is the one that answers. */
  listedIdAgrees: boolean;
  savedHasKey: boolean;
  keyMatches: boolean;
  /** The QR code's or link's name agrees with the name the computer answers with. */
  namesAgree: boolean;
  /** The computer answers with the saved computer's name. */
  usesSavedName: boolean;
}

const ROUTES: Record<PairingStart, PairingRoute> = { saved: 'pin', network: 'pin', address: 'pin', qr: 'qr', link: 'link' };
const answeringId = (row: Row) => (row.idMatches ? 'ada-mac' : 'someone-else');

/** The id the starting entry named: the saved computer's own, /hello's, or none for a QR code or link. */
function expectedId(row: Row): string | null {
  if (row.startedFrom === 'saved') return 'ada-mac';
  if (row.startedFrom === 'qr' || row.startedFrom === 'link') return null;
  return row.listedIdAgrees ? answeringId(row) : 'listed-elsewhere';
}

/** The rule as written in the brief, kept apart from the code under test. */
function expected(row: Row): string {
  const route = ROUTES[row.startedFrom];
  const listed = expectedId(row);
  if (listed !== null && listed !== answeringId(row)) return row.startedFrom === 'saved' ? 'refuse:reset' : 'refuse:id';
  if (route !== 'pin' && !row.namesAgree) return 'refuse:name';
  if (row.idMatches && row.savedHasKey) return row.keyMatches ? 'trust' : 'ask:key';
  if (row.idMatches && route === 'link') return 'refuse:legacy-link';
  if (row.idMatches) return row.startedFrom === 'saved' ? 'trust' : 'ask:legacy';
  return row.usesSavedName ? 'ask:name' : 'trust';
}

function claimFor(row: Row): PairingClaim {
  const agentName = row.usesSavedName ? SAVED_NAME : 'Build box';
  return {
    route: ROUTES[row.startedFrom],
    startedFrom: row.startedFrom,
    named: row.namesAgree ? agentName : 'Meeting room TV',
    expectedAgentId: expectedId(row),
    agentId: answeringId(row),
    agentName,
    linkKey: row.keyMatches ? SAVED_KEY : OTHER_KEY,
  };
}

const outcome = (d: TrustDecision) => (d.kind === 'ask' ? `ask:${d.conflict}` : d.kind === 'refuse' ? `refuse:${d.reason}` : d.kind);
const flags = [true, false];
const STARTS: PairingStart[] = ['saved', 'network', 'address', 'qr', 'link'];

describe('the trust rule, as a table', () => {
  for (const startedFrom of STARTS)
    for (const idMatches of flags)
      for (const listedIdAgrees of startedFrom === 'network' || startedFrom === 'address' ? flags : [true])
        for (const savedHasKey of flags)
          for (const keyMatches of flags)
            for (const namesAgree of flags)
              for (const usesSavedName of flags) {
                const row: Row = { startedFrom, idMatches, listedIdAgrees, savedHasKey, keyMatches, namesAgree, usesSavedName };
                const label =
                  `from ${startedFrom}, id ${idMatches ? 'same' : 'new'}${listedIdAgrees ? '' : ', listed id differs'}, saved ${savedHasKey ? 'with' : 'without'} key, ` +
                  `key ${keyMatches ? 'same' : 'other'}, names ${namesAgree ? 'agree' : 'differ'}, ${usesSavedName ? 'saved name' : 'own name'}`;
                it(`${label} -> ${expected(row)}`, () => {
                  assert.equal(outcome(decidePairing(claimFor(row), [saved(savedHasKey)])), expected(row));
                });
              }

  it('a link whose name differs is refused even when id and key match the saved computer', () => {
    const d = decidePairing(
      { route: 'link', startedFrom: 'link', named: 'Meeting room TV', expectedAgentId: null, agentId: 'ada-mac', agentName: SAVED_NAME, linkKey: SAVED_KEY },
      [saved(true)],
    );
    assert.deepEqual(d, { kind: 'refuse', reason: 'name' });
  });

  it('a PIN pairing from the saved entry never compares the listed name: the Re-pair names the computer', () => {
    const d = decidePairing(
      { route: 'pin', startedFrom: 'saved', named: 'Meeting room TV', expectedAgentId: 'ada-mac', agentId: 'ada-mac', agentName: SAVED_NAME, linkKey: OTHER_KEY },
      [saved(false)],
    );
    assert.deepEqual(d, { kind: 'trust', known: saved(false) });
  });

  it('a PIN pairing from the network list re-keying a computer saved before link keys asks first (F4)', () => {
    const d = decidePairing(
      { route: 'pin', startedFrom: 'network', named: 'Meeting room TV', expectedAgentId: 'ada-mac', agentId: 'ada-mac', agentName: SAVED_NAME, linkKey: OTHER_KEY },
      [saved(false)],
    );
    assert.deepEqual(d, { kind: 'ask', conflict: 'legacy', saved: saved(false) });
  });
});

describe('names compare by skeleton', () => {
  const variants: [string, string][] = [
    ['zero-width space U+200B', 'Ada’s​ MacBook'],
    ['word joiner U+2060', 'Ada’s MacBook⁠'],
    ['soft hyphen U+00AD', 'Ada’s Mac­Book'],
    ['Cyrillic а U+0430', 'Adа’s MacBook'],
    ['Greek capital Α and omicron', 'Αda’s MacBοok'],
    ['right-to-left override', '‮Ada’s MacBook'],
    ['variation selector', 'Ada’s️ MacBook'],
    ['tag characters', 'Ada’s MacBook\u{E0041}'],
    ['Hangul filler', 'Ada’sㅤMacBook'.replace('ㅤ', ' ㅤ')],
    ['fullwidth letters (NFKC)', 'Ａｄａ’s MacBook'],
    ['case, spacing and apostrophes', "  ada's   MACBOOK "],
  ];
  for (const [what, name] of variants) {
    it(`${what} reads as the same name`, () => {
      assert.ok(isSameComputerName(SAVED_NAME, name), nameSkeleton(name));
    });
  }

  it('different names stay different', () => {
    assert.equal(isSameComputerName(SAVED_NAME, 'Ada’s MacBook Pro'), false);
    assert.equal(isSameComputerName('Build box', 'Build fox'), false);
  });

  it('a name outside UTS #39 Highly Restrictive is pointed out; one script, or Latin with CJK, is not', () => {
    for (const name of ['Adа’s MacBook', 'Ada’s MacBοok', 'Ada’s Компьютер', 'Ꭺda’s ᎷacᏴook', 'ꓮꓓꓮ MacBook', 'Ada’s MacBooκ', 'Γιάννης PC']) {
      assert.equal(mixesAlphabets(name), true, name);
    }
    for (const name of ['Ada’s MacBook', 'Компьютер Ады', 'Γιάννης', 'MacBook 太郎のマック', 'MacBook 철수', 'MacBook ㄅ電腦', 'Build-box 2', '']) {
      assert.equal(mixesAlphabets(name), false, name);
    }
  });

  it('cleaning a name removes what draws nothing and keeps the rest', () => {
    assert.equal(cleanName('Ada’s​ Mac­Book⁠‮'), 'Ada’s MacBook');
    assert.equal(cleanName('​⁠'), '');
  });
});

/** Link review 4, F3: names that read the same as a saved one, from poc-skeleton-gaps.ts. */
const READ_THE_SAME: [string, string, string][] = [
  ["Paul's MacBook", "PauI's MacBook", 'Latin capital I for small l (pure ASCII)'],
  ['Sam’s iMac', 'Sarn’s iMac', '"rn" for "m" (pure ASCII)'],
  ['MacBook Pro', 'MacB00k Pro', 'digit 0 for o (pure ASCII)'],
  ['Ada’s iMac', 'Ada’s i̇Mac', 'i + U+0307 combining dot'],
  ['Ada’s MacBook', 'Ada’s MacBook⠀', 'trailing U+2800 braille blank'],
  ['Ada’s MacBook', 'Ada’s⠀MacBook', 'U+2800 braille blank as the space'],
  ['Ada’s MacBook', 'Ada’s MacBօօk', 'Armenian oh (U+0585) for o'],
  ['Ada’s MacBook', 'Ꭺda’s ᎷacᏴook', 'Cherokee A, M, B'],
  ['ADA MACBOOK', 'ꓮꓓꓮ ꓟꓮꓚꓐꓳꓳꓗ', 'Lisu capitals, every letter'],
  ['Ada’s MacBook', 'Ada’s MacBooᴋ', 'Latin small capital K (U+1D0B)'],
  ['Ada’s Mac', 'ɑda’s Mac', 'Latin alpha (U+0251) for a'],
  ['Ada’s MacBook', 'Ada’s MacBoοk', 'Greek omicron'],
  ['Ada’s MacBook', 'Ada’s MacBooκ', 'Greek kappa'],
  ['Ada’s MacBook', 'Ada’s MacBook\u{1D159}', 'U+1D159 musical null notehead'],
  ['Ada’s MacBook', 'Ada’s MacBookᅟ', 'Hangul choseong filler'],
  ['Ada’s MacBook', 'Ada’s MacBookᅠ', 'Hangul jungseong filler U+1160'],
  ['Ada’s MacBook', 'Ada’s MacBookﾠ', 'halfwidth Hangul filler U+FFA0'],
];

describe('F3: names that read the same collide with the saved one', () => {
  const real = (name: string): Computer => ({ ...saved(true), name });
  const hostile: Computer = { agentId: 'evil', name: 'Meeting room TV', platform: 'linux', hosts: ['192.168.1.66'], port: 47474, linkKey: OTHER_KEY, pairedAt: 2 };
  for (const [name, fake, what] of READ_THE_SAME) {
    it(`${what}: same skeleton, a QR pairing asks, and a rename on connect is refused`, () => {
      const fakeClean = cleanName(fake);
      assert.equal(nameSkeleton(fakeClean), nameSkeleton(name));
      const claim: PairingClaim = { route: 'qr', startedFrom: 'qr', named: fakeClean, expectedAgentId: null, agentId: 'evil', agentName: fakeClean, linkKey: OTHER_KEY };
      assert.equal(outcome(decidePairing(claim, [real(name)])), 'ask:name');
      assert.equal(acceptedIdentity(hostile, { name: fakeClean, platform: 'macos' }, [real(name), hostile]).name, 'Meeting room TV');
    });
  }

  it(`${CONFUSABLE_SAMPLE.length} pairs sampled from confusables.txt read the same, inside a name`, () => {
    assert.ok(CONFUSABLE_SAMPLE.length >= 200);
    const differ = CONFUSABLE_SAMPLE.filter(([source, target]) => {
      const a = `Ada${String.fromCodePoint(source)}Mac`;
      const b = `Ada${String.fromCodePoint(...target)}Mac`;
      return !isSameComputerName(a, b);
    });
    assert.deepEqual(differ.map(([source]) => `U+${source.toString(16)}`), []);
  });

  it('names that differ still differ', () => {
    for (const [a, b] of [
      ['Build box', 'Build fox'],
      ['Ada’s MacBook', 'Ada’s MacBook Pro'],
      ['Bob', 'Boo'],
      ['Mac mini', 'Mac maxi'],
      ['Studio 1', 'Studio 2'],
    ]) {
      assert.equal(isSameComputerName(a!, b!), false, `${a} / ${b}`);
    }
  });
});

describe('a name reported on connect', () => {
  const ada = saved(true);
  const bob: Computer = { ...saved(true), agentId: 'bob-pc', name: 'Bob’s PC', platform: 'windows', linkKey: OTHER_KEY };

  it('is taken, with its platform, when it clashes with no other saved computer', () => {
    assert.deepEqual(acceptedIdentity(bob, { name: 'Bob’s new PC', platform: 'linux' }, [ada, bob]), { name: 'Bob’s new PC', platform: 'linux' });
  });

  it('is refused, platform too, when it reads like another saved computer', () => {
    for (const name of [SAVED_NAME, 'Ada’s​ MacBook', 'Adа’s MacBook']) {
      assert.deepEqual(acceptedIdentity(bob, { name, platform: 'macos' }, [ada, bob]), { name: 'Bob’s PC', platform: 'windows' });
    }
  });

  it('loses invisible characters before it is stored', () => {
    assert.deepEqual(acceptedIdentity(bob, { name: 'Bob’s​ PC⁠', platform: 'windows' }, [ada, bob]), { name: 'Bob’s PC', platform: 'windows' });
  });

  it('a computer may keep its own name', () => {
    assert.deepEqual(acceptedIdentity(ada, { name: SAVED_NAME, platform: 'macos' }, [ada, bob]), { name: SAVED_NAME, platform: 'macos' });
  });
});
