import { Platform } from './native';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { type PairLink, parsePairLink } from '../src/net/discovery';
import { keyWordsOf } from '../src/net/linkState';
import type { PairingRoute } from '../src/net/trust';
import { PairFlowController, type PairFlowDeps } from '../src/screens/pair/pairFlow';
import {
  KEY_CHANGED_MESSAGE,
  KeyChangedError,
  NameMismatchError,
  type PairResult,
  linkStanding,
  nameClashMessage,
  savePairing,
  targetFromComputer,
  targetFromLink,
} from '../src/screens/pair/pairing';
import type { Computer } from '../src/state/model';
import { useStore } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, newLinkKey, waitFor } from './linkServers';

const savedKey = newLinkKey();
const otherKey = newLinkKey();
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAA';
const AGENT_ID = '6f1c2a9e-0000-4000-8000-000000000001';

function pairUrl(hosts: string, key = savedKey.public, name = 'Mac'): string {
  return `authdeck://pair?v=2&n=${encodeURIComponent(name)}&p=47474&h=${hosts}&k=${toBase64Url(key)}&s=${SECRET}`;
}

const savedComputer: Computer = {
  agentId: AGENT_ID,
  name: 'Ada’s MacBook',
  platform: 'macos',
  hosts: ['192.168.1.5'],
  port: 47474,
  linkKey: toBase64Url(savedKey.public),
  pairedAt: 1,
};

/** A finished pairing. The link's and the computer's names agree unless a test sets both apart. */
function result(linkKey: Uint8Array, agentId = AGENT_ID, names: { link?: string; agent?: string } = {}, route: PairingRoute = 'qr'): PairResult {
  const linkName = names.link ?? names.agent ?? 'Mac';
  const link = parsePairLink(pairUrl('192.168.1.9', linkKey, linkName))!;
  return { target: targetFromLink(link), route, agent: agentInfo(agentId, names.agent ?? linkName), host: '192.168.1.9', linkKey: toBase64Url(linkKey) };
}

const stored = () => useStore.getState().computers.find((c) => c.agentId === AGENT_ID);

beforeEach(() => {
  Platform.OS = 'ios';
  // Another computer is in use, so saving never restarts the live connection.
  useStore.setState({ computers: [savedComputer], activeId: 'elsewhere' });
});

describe('pairing links only name local addresses', () => {
  it('drops addresses outside the local network and says which', () => {
    const link = parsePairLink(pairUrl('192.168.1.5,203.0.113.9'))!;
    assert.deepEqual(link.hosts, ['192.168.1.5']);
    assert.deepEqual(link.refusedHosts, ['203.0.113.9']);
  });

  it('a link naming only outside addresses has nowhere to pair', () => {
    const link = parsePairLink(pairUrl('8.8.8.8'))!;
    assert.deepEqual(link.hosts, []);
    assert.deepEqual(link.refusedHosts, ['8.8.8.8']);
  });

  it('loopback is refused on a phone and allowed on the web build', () => {
    assert.deepEqual(parsePairLink(pairUrl('127.0.0.1'))!.hosts, []);
    Platform.OS = 'web';
    assert.deepEqual(parsePairLink(pairUrl('127.0.0.1'))!.hosts, ['127.0.0.1']);
  });
});

/** A flow whose network calls are recorded instead of made. */
function recordedFlow(answer: (call: number) => Promise<PairResult>) {
  const calls: string[] = [];
  const paired: string[] = [];
  const deps: Partial<PairFlowDeps> & Pick<PairFlowDeps, 'onPaired'> = {
    pairByLink: (link) => {
      calls.push(`link:${link.hosts.join(',')}`);
      return answer(calls.length);
    },
    pairByPin: (_target, pin) => {
      calls.push(`pin:${pin}`);
      return answer(calls.length);
    },
    onPaired: (name) => paired.push(name),
  };
  return { flow: new PairFlowController(null, deps), calls, paired };
}

describe('a link never pairs on its own', () => {
  it('an offered link waits for the person to confirm', async () => {
    const { flow, calls } = recordedFlow(async () => result(savedKey.public));
    const link = parsePairLink(pairUrl('192.168.1.9'))!;
    flow.offerLink(link);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, []);
    assert.equal(flow.getState().offeredLink, link);
    assert.equal(flow.getState().busy, false);
    flow.confirmLink();
    assert.deepEqual(calls, ['link:192.168.1.9']);
    assert.equal(flow.getState().offeredLink, null);
  });

  it('dismissing the link sends nothing', () => {
    const { flow, calls } = recordedFlow(async () => result(savedKey.public));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9'))!);
    flow.dismissLink();
    flow.confirmLink();
    assert.deepEqual(calls, []);
  });

  it('a link with no local address cannot be confirmed', () => {
    const { flow, calls } = recordedFlow(async () => result(savedKey.public));
    flow.offerLink(parsePairLink(pairUrl('8.8.8.8'))!);
    flow.confirmLink();
    assert.deepEqual(calls, []);
  });
});

describe('a saved computer’s key is not replaced silently', () => {
  it('a different key for a saved computer is refused and nothing is saved', () => {
    assert.throws(() => savePairing(result(otherKey.public)), (e: unknown) => e instanceof KeyChangedError && e.message === KEY_CHANGED_MESSAGE);
    assert.deepEqual(stored(), savedComputer);
  });

  it('the different key is saved when the person chooses to', () => {
    savePairing(result(otherKey.public), { confirmed: 'key' });
    assert.equal(stored()!.linkKey, toBase64Url(otherKey.public));
  });

  it('the same key re-pairs silently', () => {
    assert.equal(savePairing(result(savedKey.public)), 'Mac');
    assert.equal(stored()!.linkKey, savedComputer.linkKey);
    assert.deepEqual(stored()!.hosts, ['192.168.1.9']);
  });

  it('only local addresses are saved', () => {
    const r = result(savedKey.public);
    savePairing({ ...r, target: { ...r.target, hosts: ['192.168.1.9', '203.0.113.9'] } });
    assert.deepEqual(stored()!.hosts, ['192.168.1.9']);
  });

  it('the flow asks, and "Pair anyway" saves the pairing already in hand without pairing again', async () => {
    const { flow, calls, paired } = recordedFlow(async () => result(otherKey.public));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public))!);
    flow.confirmLink();
    await waitFor('the key-change question', () => flow.getState().keyChange !== null);
    const change = flow.getState().keyChange!;
    assert.equal(change.savedWords, keyWordsOf(savedComputer.linkKey!));
    assert.equal(change.newWords, keyWordsOf(toBase64Url(otherKey.public)));
    assert.equal(stored()!.linkKey, savedComputer.linkKey);
    flow.pairAnyway();
    assert.equal(stored()!.linkKey, toBase64Url(otherKey.public));
    assert.deepEqual(calls, ['link:192.168.1.9']);
    assert.deepEqual(paired, ['Mac']);
  });

  it('keeping the saved computer saves nothing; PIN pairing is guarded the same way', async () => {
    const { flow, paired } = recordedFlow(async () => result(otherKey.public));
    flow.choose(targetFromLink(parsePairLink(pairUrl('192.168.1.9'))!));
    for (const digit of '123456') flow.typeDigit(digit);
    await waitFor('the key-change question', () => flow.getState().keyChange !== null);
    flow.keepSaved();
    assert.equal(flow.getState().keyChange, null);
    assert.equal(flow.getState().problem?.kind, 'other');
    assert.deepEqual(stored(), savedComputer);
    assert.deepEqual(paired, []);
  });
});

describe('the review’s QR scenario (an agent claiming a saved computer’s id)', () => {
  let liar: TestServer | null = null;
  after(() => liar?.close());

  it('a QR code naming another key, answered with the saved id, does not replace the saved computer', async () => {
    Platform.OS = 'web';
    liar = await agentServer('127.0.0.1', 0, { key: otherKey, info: agentInfo(AGENT_ID, 'Ada’s MacBook') });
    const link: PairLink = { ...parsePairLink(pairUrl('127.0.0.1', otherKey.public, 'Ada’s MacBook'))!, port: liar.port };
    const paired: string[] = [];
    const flow = new PairFlowController(null, { onPaired: (name) => paired.push(name) });
    flow.offerLink(link);
    flow.confirmLink();
    await waitFor('the key-change question', () => flow.getState().keyChange !== null || flow.getState().problem !== null);
    assert.equal(flow.getState().problem, null);
    assert.equal(flow.getState().keyChange!.name, 'Ada’s MacBook');
    assert.deepEqual(stored(), savedComputer);
    assert.deepEqual(paired, []);
  });
});

const NEW_ID = '6f1c2a9e-0000-4000-8000-000000000002';
const newId = () => useStore.getState().computers.find((c) => c.agentId === NEW_ID);

describe('a look-alike computer (a saved computer’s name, another id and key)', () => {
  const clash = (e: unknown) => e instanceof KeyChangedError && e.conflict === 'name' && e.message === nameClashMessage('Ada’s MacBook');

  it('the link’s name matching a saved computer asks first, and saves nothing', () => {
    assert.throws(() => savePairing(result(otherKey.public, NEW_ID, { link: 'Ada’s MacBook' })), clash);
    assert.deepEqual(useStore.getState().computers, [savedComputer]);
  });

  it('the name the computer gives once connected is checked too (a PIN pairing from the network list)', () => {
    assert.throws(() => savePairing(result(otherKey.public, NEW_ID, { link: 'Build box', agent: 'Ada’s MacBook' }, 'pin')), clash);
  });

  it('names are compared as a person reads them: case, spacing and apostrophes', () => {
    for (const name of ["ada's macbook", '  ADA’S   MACBOOK ', 'Ada‘s MacBook', 'Adaʼs MacBook']) {
      assert.throws(() => savePairing(result(otherKey.public, NEW_ID, { agent: name })), clash, name);
    }
  });

  it('the question reads exactly as specified', () => {
    assert.equal(nameClashMessage('Ada’s MacBook'), 'You already have a computer called Ada’s MacBook, and this is a different one. Only continue if you know why.');
  });

  it('a differently named new computer saves without asking', () => {
    assert.equal(savePairing(result(otherKey.public, NEW_ID, { agent: 'Build box', link: 'Build box' })), 'Build box');
    assert.ok(newId());
  });

  it('re-pairing a saved computer with its own key never asks, even beside a same-named one', () => {
    useStore.setState({ computers: [savedComputer, { ...savedComputer, agentId: NEW_ID, linkKey: toBase64Url(otherKey.public) }] });
    assert.doesNotThrow(() => savePairing(result(savedKey.public, AGENT_ID, { agent: 'Ada’s MacBook', link: 'Ada’s MacBook' })));
  });

  it('the review’s link scenario: a real agent using the saved name raises the question; the active computer stays', async () => {
    Platform.OS = 'web';
    useStore.setState({ activeId: AGENT_ID });
    const evil = await agentServer('127.0.0.1', 0, { key: otherKey, info: agentInfo(NEW_ID, 'Ada’s MacBook') });
    try {
      const link: PairLink = { ...parsePairLink(pairUrl('127.0.0.1', otherKey.public, 'Ada’s MacBook'))!, port: evil.port };
      const paired: string[] = [];
      const flow = new PairFlowController(null, { onPaired: (name) => paired.push(name) });
      flow.offerLink(link);
      flow.confirmLink();
      await waitFor('the question', () => flow.getState().keyChange !== null || flow.getState().problem !== null);
      const change = flow.getState().keyChange!;
      assert.equal(change.conflict, 'name');
      assert.equal(change.message, nameClashMessage('Ada’s MacBook'));
      assert.equal(change.savedWords, keyWordsOf(savedComputer.linkKey!));
      assert.equal(change.newWords, keyWordsOf(toBase64Url(otherKey.public)));
      assert.equal(useStore.getState().activeId, AGENT_ID);
      assert.deepEqual(useStore.getState().computers, [savedComputer]);
      assert.deepEqual(paired, []);
    } finally {
      await evil.close();
    }
  });

  it('"Pair anyway" saves it as a separate computer and switches to it: the person chose it', async () => {
    const { flow, paired } = recordedFlow(async () => result(otherKey.public, NEW_ID, { agent: 'Ada’s MacBook' }));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public))!);
    flow.confirmLink();
    await waitFor('the question', () => flow.getState().keyChange !== null);
    flow.pairAnyway();
    assert.equal(useStore.getState().computers.length, 2);
    assert.equal(useStore.getState().activeId, NEW_ID);
    assert.deepEqual(stored(), savedComputer);
    assert.deepEqual(paired, ['Ada’s MacBook']);
  });
});

describe('pairing never switches the active computer unless the person chose it', () => {
  it('savePairing on its own adds without switching', () => {
    savePairing(result(otherKey.public, NEW_ID, { agent: 'Build box', link: 'Build box' }));
    assert.ok(newId());
    assert.equal(useStore.getState().activeId, 'elsewhere');
  });

  it('a link the person confirmed becomes active once paired', async () => {
    const { flow, paired } = recordedFlow(async () => result(otherKey.public, NEW_ID, { agent: 'Build box', link: 'Build box' }));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Build box'))!);
    flow.confirmLink();
    await waitFor('paired', () => flow.getState().paired);
    assert.equal(useStore.getState().activeId, NEW_ID);
    assert.deepEqual(paired, ['Build box']);
  });

  it('a pairing that finishes after the person moved on is kept, but not switched to', async () => {
    let finish: (r: PairResult) => void = () => undefined;
    const { flow, paired } = recordedFlow((call) =>
      call === 1 ? new Promise<PairResult>((resolve) => (finish = resolve)) : new Promise<PairResult>(() => undefined),
    );
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Build box'))!);
    flow.confirmLink();
    // The person walks away to another computer before the first one answers.
    flow.choose(targetFromLink(parsePairLink(pairUrl('192.168.1.20'))!));
    finish(result(otherKey.public, NEW_ID, { agent: 'Build box', link: 'Build box' }));
    await waitFor('the unattended save', () => !!newId());
    assert.equal(useStore.getState().activeId, 'elsewhere');
    assert.deepEqual(paired, []);
  });

  it('an unattended look-alike is not saved at all', async () => {
    let finish: (r: PairResult) => void = () => undefined;
    const { flow } = recordedFlow(() => new Promise<PairResult>((resolve) => (finish = resolve)));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public))!);
    flow.confirmLink();
    flow.choose(null);
    finish(result(otherKey.public, NEW_ID, { agent: 'Ada’s MacBook' }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(newId(), undefined);
    assert.equal(useStore.getState().activeId, 'elsewhere');
  });
});

describe('the confirm sheet says whether the link names a new or a saved computer', () => {
  const computers = [savedComputer];

  it('a link with a saved computer’s key is that computer', () => {
    const standing = linkStanding(parsePairLink(pairUrl('192.168.1.9', savedKey.public, 'Renamed'))!, computers);
    assert.equal(standing.kind, 'saved');
    assert.equal(standing.kind === 'saved' && standing.computer.agentId, AGENT_ID);
  });

  it('a link with another key is new, and a borrowed name is pointed out', () => {
    const lookAlike = linkStanding(parsePairLink(pairUrl('192.168.1.9', otherKey.public, "ada's macbook"))!, computers);
    assert.deepEqual(lookAlike, { kind: 'new', lookAlike: savedComputer });
    assert.deepEqual(linkStanding(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Build box'))!, computers), { kind: 'new', lookAlike: null });
  });
});

/** Pairs through a real agent at a link naming `linkName`; resolves once the flow settles. */
async function pairThroughLink(server: TestServer, key: Uint8Array, linkName: string, fromOtherApp = false) {
  const link: PairLink = { ...parsePairLink(pairUrl('127.0.0.1', key, linkName))!, port: server.port, ...(fromOtherApp ? { fromOtherApp } : {}) };
  const paired: string[] = [];
  const flow = new PairFlowController(null, { onPaired: (name) => paired.push(name) });
  flow.offerLink(link);
  flow.confirmLink();
  await waitFor('the pairing to settle', () => flow.getState().paired || flow.getState().problem !== null || flow.getState().keyChange !== null);
  return { flow, paired };
}

describe('a computer saved before link keys (no linkKey)', () => {
  const legacy: Computer = { agentId: AGENT_ID, name: 'Ada’s MacBook', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, pairedAt: 1 };
  beforeEach(() => {
    useStore.setState({ computers: [legacy], decks: {}, activeId: 'elsewhere' });
  });

  it('by QR code: asks to compare key words, and saves nothing until "They match"', async () => {
    Platform.OS = 'web';
    const agent = await agentServer('127.0.0.1', 0, { key: otherKey, info: agentInfo(AGENT_ID, 'Ada’s MacBook') });
    try {
      const { flow, paired } = await pairThroughLink(agent, otherKey.public, 'Ada’s MacBook');
      const change = flow.getState().keyChange!;
      assert.equal(change.conflict, 'legacy');
      assert.equal(change.message, 'Do these words match the ones AuthDeck Agent shows on Ada’s MacBook?');
      assert.equal(change.newWords, keyWordsOf(toBase64Url(otherKey.public)));
      assert.deepEqual(stored(), legacy);
      assert.deepEqual(paired, []);
      flow.pairAnyway();
      assert.equal(stored()!.linkKey, toBase64Url(otherKey.public));
      assert.deepEqual(paired, ['Ada’s MacBook']);
    } finally {
      await agent.close();
    }
  });

  it('by a link from another app: refused, and told to use Re-pair', async () => {
    Platform.OS = 'web';
    const agent = await agentServer('127.0.0.1', 0, { key: otherKey, info: agentInfo(AGENT_ID, 'Ada’s MacBook') });
    try {
      const { flow, paired } = await pairThroughLink(agent, otherKey.public, 'Ada’s MacBook', true);
      assert.equal(flow.getState().keyChange, null);
      assert.equal(flow.getState().problem?.title, 'Did not pair with Ada’s MacBook.');
      assert.equal(flow.getState().problem?.detail, 'To pair Ada’s MacBook again, open it in Computers and tap Re-pair.');
      assert.deepEqual(stored(), legacy);
      assert.deepEqual(paired, []);
    } finally {
      await agent.close();
    }
  });

  it('by this app’s camera from its own Re-pair: takes the key without a question', async () => {
    const asked: (string | null)[] = [];
    const paired: string[] = [];
    const flow = new PairFlowController(targetFromComputer(legacy), {
      onPaired: (name) => paired.push(name),
      pairByLink: async (link, repairAgentId) => {
        asked.push(repairAgentId);
        return { target: targetFromLink(link, repairAgentId), route: 'qr', agent: agentInfo(AGENT_ID, 'Ada’s MacBook'), host: '192.168.1.9', linkKey: toBase64Url(otherKey.public) };
      },
    });
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Ada’s MacBook'))!);
    flow.confirmLink();
    await waitFor('the pairing', () => flow.getState().paired || flow.getState().problem !== null || flow.getState().keyChange !== null);
    assert.deepEqual(asked, [AGENT_ID]);
    assert.equal(flow.getState().keyChange, null);
    assert.equal(stored()!.linkKey, toBase64Url(otherKey.public));
    assert.deepEqual(paired, ['Ada’s MacBook']);
  });

  it('a QR code for another computer, scanned from a Re-pair, is an ordinary pairing', async () => {
    const asked: (string | null)[] = [];
    const flow = new PairFlowController(targetFromComputer(legacy), {
      onPaired: () => {},
      pairByLink: async (link, repairAgentId) => {
        asked.push(repairAgentId);
        throw new Error('stop');
      },
    });
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Meeting room TV'))!);
    flow.confirmLink();
    await waitFor('the attempt', () => asked.length > 0);
    assert.deepEqual(asked, [null]);
  });

  it('a link from another app never counts as started from a Re-pair', () => {
    const link = { ...parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Ada’s MacBook'))!, fromOtherApp: true };
    assert.deepEqual([targetFromLink(link, AGENT_ID).startedFrom, targetFromLink(link, AGENT_ID).agentId], ['link', null]);
  });

  it('Cancel on the question saves nothing', async () => {
    const { flow } = recordedFlow(async () => result(otherKey.public, AGENT_ID, { agent: 'Ada’s MacBook' }));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Ada’s MacBook'))!);
    flow.confirmLink();
    await waitFor('the question', () => flow.getState().keyChange !== null);
    flow.keepSaved();
    assert.deepEqual(stored(), legacy);
  });

  it('by PIN from its own saved entry (Re-pair): takes the key without a question', () => {
    const pin = { ...result(otherKey.public, AGENT_ID, { agent: 'Ada’s MacBook' }, 'pin'), target: targetFromComputer(legacy) };
    assert.equal(savePairing(pin), 'Ada’s MacBook');
    assert.equal(stored()!.linkKey, toBase64Url(otherKey.public));
  });

  for (const startedFrom of ['network', 'address'] as const) {
    it(`by PIN from the ${startedFrom === 'network' ? 'network list' : 'typed address'}: asks to compare key words; the PIN proves only the screen`, () => {
      const r = result(otherKey.public, AGENT_ID, { agent: 'Ada’s MacBook' }, 'pin');
      const pin = { ...r, target: { ...r.target, name: 'Meeting room TV', agentId: AGENT_ID, startedFrom } };
      assert.throws(() => savePairing(pin), (e: unknown) => e instanceof KeyChangedError && e.conflict === 'legacy');
      assert.deepEqual(stored(), legacy);
    });
  }

  it('an answer to another question does not count as "They match"', () => {
    assert.throws(() => savePairing(result(otherKey.public, AGENT_ID, { agent: 'Ada’s MacBook' }), { confirmed: 'name' }), KeyChangedError);
    assert.deepEqual(stored(), legacy);
  });

  it('an unattended QR pairing is not saved', async () => {
    let finish: (r: PairResult) => void = () => undefined;
    const { flow } = recordedFlow(() => new Promise<PairResult>((resolve) => (finish = resolve)));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Ada’s MacBook'))!);
    flow.confirmLink();
    flow.choose(null);
    finish(result(otherKey.public, AGENT_ID, { agent: 'Ada’s MacBook' }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(stored(), legacy);
  });
});

describe('a QR code or link must name the computer that answers', () => {
  it('a different name is refused in the app’s words, and nothing is saved', async () => {
    const { flow, paired } = recordedFlow(async () => result(otherKey.public, NEW_ID, { link: 'Meeting room TV', agent: 'Build box' }));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Meeting room TV'))!);
    flow.confirmLink();
    await waitFor('the refusal', () => flow.getState().problem !== null);
    assert.deepEqual(flow.getState().problem, {
      kind: 'other',
      title: "This isn't Meeting room TV.",
      detail:
        'The computer that answered gives a different name, so AuthDeck did not pair with it. Scan the QR code AuthDeck Agent shows on the computer you want, or type its PIN.',
    });
    assert.equal(flow.getState().keyChange, null);
    assert.equal(newId(), undefined);
    assert.deepEqual(paired, []);
  });

  it('the refusal holds for a saved computer’s own id and key, and cannot be confirmed away', () => {
    const r = result(savedKey.public, AGENT_ID, { link: 'Meeting room TV', agent: 'Ada’s MacBook' });
    for (const confirmed of ['key', 'legacy', 'name'] as const) assert.throws(() => savePairing(r, { confirmed }), NameMismatchError);
    assert.deepEqual(stored(), savedComputer);
  });

  it('an unattended pairing with a different name is not saved', async () => {
    let finish: (r: PairResult) => void = () => undefined;
    const { flow } = recordedFlow(() => new Promise<PairResult>((resolve) => (finish = resolve)));
    flow.offerLink(parsePairLink(pairUrl('192.168.1.9', otherKey.public, 'Meeting room TV'))!);
    flow.confirmLink();
    flow.choose(null);
    finish(result(otherKey.public, NEW_ID, { link: 'Meeting room TV', agent: 'Build box' }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(newId(), undefined);
  });
});

describe('refusals from a computer that is not saved here', () => {
  const LIES = { code: 'unauthorized' as const, message: 'Your computer was reset by IT.', hint: 'Scan the code we emailed you.' };

  it('are shown in the app’s words for the code, never the computer’s', async () => {
    Platform.OS = 'web';
    const agent = await agentServer('127.0.0.1', 0, { key: otherKey, info: agentInfo(NEW_ID, 'Build box'), refusePairing: LIES });
    try {
      const { flow } = await pairThroughLink(agent, otherKey.public, 'Build box');
      assert.deepEqual(flow.getState().problem, {
        kind: 'other',
        title: 'The computer did not accept this pairing.',
        detail: 'Scan the QR code the computer shows now, or type its PIN.',
      });
    } finally {
      await agent.close();
    }
  });

  it('a saved computer (its key proven) keeps its own words', async () => {
    Platform.OS = 'web';
    const agent = await agentServer('127.0.0.1', 0, { key: savedKey, info: agentInfo(AGENT_ID, 'Mac'), refusePairing: LIES });
    try {
      const { flow } = await pairThroughLink(agent, savedKey.public, 'Mac');
      assert.equal(flow.getState().problem?.title, LIES.message);
    } finally {
      await agent.close();
    }
  });
});
