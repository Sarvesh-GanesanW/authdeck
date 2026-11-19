/**
 * Sample env sets for building and screenshotting the env screens before the engine
 * (src/auth/useEnv.ts) lands. It implements the frozen contract (src/auth/envContract.ts) over an
 * in-memory store; screens reach it only through ./source. Every state the screens draw has a
 * scenario (mockEnvScenario) and every request kind can be put on screen (mockEnvRequest).
 * People, projects and values are made up.
 */
import { create } from 'zustand';

import type {
  EnvActions,
  EnvChangeView,
  EnvEndedRequestView,
  EnvHistoryItemView,
  EnvJoinRequestView,
  EnvMemberView,
  EnvProblemView,
  EnvRequestView,
  EnvSetView,
  EnvSnapshot,
  EnvVariableView,
} from '../../auth/envContract';
import { envLoadsCode } from '../../envcore/codeLoading';
import { ENV_LIMITS, ENV_NAME_PATTERN, envFileProblemWords } from '../../envcore/types';

const SECOND = 1000;
const MIN = 60 * SECOND;
const DAY = 24 * 60 * MIN;
/** A computer gives a device this long to answer before the CLI gives up. */
const REQUEST_MS = 60 * SECOND;
const GRANT_MS = 15 * MIN;
const HISTORY_PAGE = 4;
const THIS_DEVICE = 'Maya Rao · Pixel 8';
const THIS_PERSON = 'Maya';
const COMPUTER = 'MacBook Pro';
/** The only phrase becomeOwner accepts here. */
export const MOCK_OWNER_PHRASE = 'guard tank tongue pass mask doll joy bargain dragon hole slide depend'.split(' ');

const now = () => Date.now();
const wait = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SetData {
  variables: EnvVariableView[];
  members: EnvMemberView[];
  values: Record<string, string>;
  history: EnvHistoryItemView[];
}

interface PushData {
  values: { name: string; value: string }[];
  changes: EnvChangeView[];
}

interface MockEnvState extends EnvSnapshot {
  data: Record<string, SetData>;
  pushes: Record<string, PushData>;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

function member(id: string, label: string, role: EnvMemberView['role'], sinceDaysAgo: number, form: EnvMemberView['form'] = 'phone'): EnvMemberView {
  return { id, label, form, role, thisDevice: label === THIS_DEVICE, since: now() - sinceDaysAgo * DAY };
}

function variable(name: string, version: number, by: string, ago: number): EnvVariableView {
  return { name, version, by, byMemberId: by === THIS_PERSON ? 'm-maya-pixel' : `m-${by.toLowerCase()}`, time: now() - ago, loadsCode: envLoadsCode(name) };
}

function commit(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

function history(setName: string, lines: [ago: number, text: string, by: string, signed?: boolean][]): EnvHistoryItemView[] {
  return lines.map(([ago, text, by, signed = true]) => ({ commit: commit(`${setName}:${text}:${ago}`), time: now() - ago, text, by, signed }));
}

const ACME_VALUES: Record<string, string> = {
  DATABASE_URL: 'postgres://api:Vq4t9LmX2s@db.acme.internal:5432/api',
  REDIS_URL: 'redis://cache.acme.internal:6379/0',
  STRIPE_SECRET_KEY: 'sk_test_example_4242',
  STRIPE_WEBHOOK_SECRET: 'whsec_Q3n8Vt2LmKx7Pa0Rw5Yc',
  SENTRY_DSN: 'https://4f1c0e8a@o4501.ingest.sentry.io/451',
  POSTMARK_TOKEN: '3b9f6a12-77d0-4c1e-9a55-0e2b8c4d1f90',
  S3_BUCKET: 'acme-api-uploads-dev',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE7Q2LM4ZX',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  JWT_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIExampleOnlyNotARealKey0123456789ab\n-----END PRIVATE KEY-----',
  LEGACY_API_KEY: 'lk_live_0f3e9b2a7c',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NODE_OPTIONS: '--max-old-space-size=4096',
};

function acmeVariables(): EnvVariableView[] {
  return [
    variable('DATABASE_URL', 4, 'Maya', 6 * DAY),
    variable('REDIS_URL', 2, 'Maya', 16 * DAY),
    variable('STRIPE_SECRET_KEY', 7, 'Ben', 66 * MIN),
    variable('STRIPE_WEBHOOK_SECRET', 5, 'Maya', 28 * MIN),
    variable('SENTRY_DSN', 1, 'Maya', 21 * DAY),
    variable('POSTMARK_TOKEN', 3, 'Priya', 4 * DAY),
    variable('S3_BUCKET', 1, 'Maya', 21 * DAY),
    variable('AWS_ACCESS_KEY_ID', 2, 'Ben', 9 * DAY),
    variable('AWS_SECRET_ACCESS_KEY', 2, 'Ben', 9 * DAY),
    variable('JWT_SIGNING_KEY', 1, 'Maya', 21 * DAY),
    variable('LEGACY_API_KEY', 1, 'Maya', 40 * DAY),
    variable('NEXT_PUBLIC_APP_URL', 1, 'Maya', 21 * DAY),
    variable('NODE_OPTIONS', 1, 'Ben', 5 * DAY),
  ];
}

function sampleData(): Record<string, SetData> {
  return {
    'set-acme-api': {
      variables: acmeVariables(),
      members: [
        member('m-maya-pixel', THIS_DEVICE, 'owner', 21),
        member('m-maya-ipad', 'Maya Rao · iPad mini', 'member', 6, 'tablet'),
        member('m-ben', 'Ben Okafor · Pixel 9', 'member', 6),
        member('m-priya', 'Priya Nair · Pixel 7a', 'member', 4),
      ],
      values: { ...ACME_VALUES },
      history: history('acme-api', [
        [28 * MIN, 'Changed STRIPE_WEBHOOK_SECRET', THIS_DEVICE],
        [66 * MIN, 'Changed STRIPE_SECRET_KEY', 'Ben Okafor · Pixel 9'],
        [4 * DAY, 'Added Priya Nair', THIS_DEVICE],
        [4 * DAY + 2 * MIN, 'Changed POSTMARK_TOKEN', 'Priya Nair · Pixel 7a'],
        [6 * DAY, 'Added Ben Okafor', THIS_DEVICE],
        [6 * DAY + 5 * MIN, 'Added Maya Rao · iPad mini', THIS_DEVICE],
        [21 * DAY, 'Removed Lucía Ortiz and made a new key', THIS_DEVICE],
        [21 * DAY + 9 * MIN, 'Changed DATABASE_URL', 'maya@acme.dev', false],
        [22 * DAY, 'Created acme-api with 12 variables', THIS_DEVICE],
      ]),
    },
    'set-acme-api-prod': {
      variables: [
        variable('DATABASE_URL', 2, 'Maya', 9 * DAY),
        variable('REDIS_URL', 1, 'Maya', 21 * DAY),
        variable('STRIPE_SECRET_KEY', 3, 'Maya', 9 * DAY),
        variable('STRIPE_WEBHOOK_SECRET', 2, 'Maya', 9 * DAY),
        variable('SENTRY_DSN', 1, 'Maya', 21 * DAY),
        variable('JWT_SIGNING_KEY', 1, 'Maya', 21 * DAY),
      ],
      members: [member('m-maya-pixel', THIS_DEVICE, 'owner', 21), member('m-maya-ipad', 'Maya Rao · iPad mini', 'member', 6, 'tablet')],
      values: {
        DATABASE_URL: 'postgres://api:Yh2w7Rk9@db-prod.acme.internal:5432/api',
        REDIS_URL: 'redis://cache-prod.acme.internal:6379/0',
        STRIPE_SECRET_KEY: 'sk_live_example_4242',
        STRIPE_WEBHOOK_SECRET: 'whsec_prod_8Hc2Lq0Zt5',
        SENTRY_DSN: 'https://9a2e@o4501.ingest.sentry.io/452',
        JWT_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIProdExampleOnly\n-----END PRIVATE KEY-----',
      },
      history: history('acme-api-prod', [
        [9 * DAY, 'Changed STRIPE_SECRET_KEY', THIS_DEVICE],
        [21 * DAY, 'Created acme-api-prod with 6 variables', THIS_DEVICE],
      ]),
    },
    'set-ledgerline': {
      variables: [
        variable('DATABASE_URL', 6, 'Ben', 2 * DAY),
        variable('KAFKA_BROKERS', 2, 'Ben', 12 * DAY),
        variable('KAFKA_SASL_PASSWORD', 3, 'Ben', 12 * DAY),
        variable('PLAID_CLIENT_ID', 1, 'Lin', 30 * DAY),
        variable('PLAID_SECRET', 2, 'Lin', 18 * DAY),
        variable('OPENEXCHANGE_APP_ID', 1, 'Ben', 30 * DAY),
        variable('SESSION_SECRET', 1, 'Ben', 30 * DAY),
        variable('SMTP_URL', 2, 'Maya', 7 * DAY),
        variable('LOG_LEVEL', 1, 'Ben', 30 * DAY),
      ],
      members: [
        member('m-ben', 'Ben Okafor · Pixel 9', 'owner', 30),
        member('m-lin', 'Lin Zhao · iPhone 15', 'member', 30),
        member('m-sam', 'Sam Patel · Galaxy S24', 'member', 25),
        member('m-maya-pixel', THIS_DEVICE, 'member', 14),
        member('m-maya-ipad', 'Maya Rao · iPad mini', 'member', 6, 'tablet'),
        member('m-ines', 'Inês Costa · Pixel 8a', 'member', 3),
      ],
      values: {
        DATABASE_URL: 'postgres://ledger:Pz8q@db.ledgerline.dev:5432/ledger',
        KAFKA_BROKERS: 'kafka-1.ledgerline.dev:9093,kafka-2.ledgerline.dev:9093',
        KAFKA_SASL_PASSWORD: 'kp_7d1f0c9e2b',
        PLAID_CLIENT_ID: '64f0c2a9e1b7d3',
        PLAID_SECRET: 'sandbox-3f9e0a7c1d2b',
        OPENEXCHANGE_APP_ID: 'oxr_51ac9f',
        SESSION_SECRET: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
        SMTP_URL: 'smtp://postmaster:mail@smtp.ledgerline.dev:587',
        LOG_LEVEL: 'debug',
      },
      history: history('ledgerline', [
        [2 * DAY, 'Changed DATABASE_URL', 'Ben Okafor · Pixel 9'],
        [3 * DAY, 'Added Inês Costa', 'Ben Okafor · Pixel 9'],
        [7 * DAY, 'Changed SMTP_URL', THIS_DEVICE],
      ]),
    },
    'set-pebble': {
      variables: [
        variable('OPENAI_API_KEY', 2, 'Maya', 3 * DAY),
        variable('SUPABASE_URL', 1, 'Maya', 10 * DAY),
        variable('SUPABASE_ANON_KEY', 1, 'Maya', 10 * DAY),
        variable('PORT', 1, 'Maya', 10 * DAY),
      ],
      members: [member('m-maya-pixel', THIS_DEVICE, 'owner', 10)],
      values: {
        OPENAI_API_KEY: 'sk-proj-ExampleOnly0123456789',
        SUPABASE_URL: 'https://pebble-example.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.example.signature',
        PORT: '5173',
      },
      history: history('pebble', [
        [3 * DAY, 'Changed OPENAI_API_KEY', THIS_DEVICE],
        [10 * DAY, 'Created pebble with 4 variables', THIS_DEVICE],
      ]),
    },
    'set-tidepool-web': {
      variables: [variable('CMS_API_TOKEN', 3, 'Ben', 9 * DAY), variable('PREVIEW_SECRET', 1, 'Ben', 16 * DAY), variable('IMAGE_CDN_KEY', 2, 'Maya', 14 * DAY)],
      members: [],
      values: { CMS_API_TOKEN: 'cms_9f8e7d6c5b', PREVIEW_SECRET: 'prv_0a1b2c3d', IMAGE_CDN_KEY: 'cdn_77aa88bb' },
      history: history('tidepool-web', [[4 * DAY, 'Removed Maya Rao · Pixel 8 and made a new key', 'Ben Okafor · Pixel 9']]),
    },
    'set-acme-web': { variables: [], members: [], values: {}, history: [] },
  };
}

function setView(partial: Partial<EnvSetView> & Pick<EnvSetView, 'id' | 'name' | 'role'>): EnvSetView {
  return {
    repo: null,
    file: `.authdeck/${partial.name}.env`,
    ownerLabel: partial.role === 'owner' ? THIS_DEVICE : null,
    computerName: COMPUTER,
    computerOnline: true,
    variableCount: 0,
    memberCount: 1,
    grant: null,
    lastReleasedAt: null,
    syncedAt: now() - 2 * MIN,
    joinRequestCount: 0,
    problems: [],
    removedNote: null,
    refusedNote: null,
    ...partial,
  };
}

function sampleSets(): EnvSetView[] {
  return [
    setView({
      id: 'set-acme-api',
      name: 'acme-api',
      repo: 'acme/api',
      role: 'owner',
      variableCount: 12,
      memberCount: 4,
      grant: { grantId: 'g1', computerName: COMPUTER, endsAt: now() + 10 * MIN, by: THIS_DEVICE, usedBy: ['npm run dev', 'npm test'] },
      lastReleasedAt: now() - 5 * MIN,
      joinRequestCount: 1,
    }),
    setView({ id: 'set-acme-api-prod', name: 'acme-api-prod', repo: 'acme/api', role: 'owner', variableCount: 6, memberCount: 2, lastReleasedAt: now() - 140 * MIN }),
    setView({ id: 'set-ledgerline', name: 'ledgerline', repo: 'ledgerline/core', role: 'member', ownerLabel: 'Ben Okafor · Pixel 9', variableCount: 9, memberCount: 6, lastReleasedAt: now() - 2 * DAY }),
    setView({ id: 'set-pebble', name: 'pebble', repo: null, role: 'owner', variableCount: 4, memberCount: 1 }),
    setView({ id: 'set-acme-web', name: 'acme-web', repo: 'acme/web', role: 'outside', ownerLabel: 'Maya Rao · iPad mini', variableCount: 7, memberCount: 3 }),
    setView({
      id: 'set-tidepool-web',
      name: 'tidepool-web',
      repo: 'tidepool/web',
      role: 'removed',
      ownerLabel: 'Ben Okafor · Pixel 9',
      variableCount: 3,
      memberCount: 3,
      syncedAt: now() - 4 * DAY,
      removedNote: "Ben Okafor's Pixel 9 removed this phone from tidepool-web in commit 3d2f8aa and made a new key.",
    }),
  ];
}

const CHEN_JOIN: EnvJoinRequestView = {
  id: 'join-chen',
  via: 'teammate',
  setId: 'set-acme-api',
  setName: 'acme-api',
  label: 'Chen Wei · iPhone 16',
  form: 'phone',
  keyWords: ['harbor', 'velvet', 'quarry', 'mosaic', 'lantern', 'ember'],
  commit: '9b07d13',
  code: null,
  expiresAt: null,
  ownerKeyWords: ['saddle', 'orchard', 'pilot', 'cobalt', 'drift', 'meadow'],
  needsUnlock: false,
};

const IPAD_JOIN: EnvJoinRequestView = {
  id: 'join-ipad',
  via: 'own-device',
  setId: 'set-pebble',
  setName: 'pebble',
  label: 'Maya Rao · iPad mini',
  form: 'tablet',
  keyWords: null,
  commit: null,
  code: null,
  expiresAt: now() + 5 * MIN,
  ownerKeyWords: null,
  needsUnlock: false,
};

const OLD_KEY_NAMES = ['STRIPE_SECRET_KEY', 'POSTMARK_TOKEN'];

/** Values a member saved under the key from before the last removal: the owner reviews them. */
function epochProblem(): EnvProblemView {
  return {
    id: 'p-epoch',
    kind: 'epoch',
    severity: 'warning',
    title: 'Values under an old key',
    text: 'A member saved these with the key from before the last removal. Nothing new is encrypted under that key until the owner reviews them.',
    names: [...OLD_KEY_NAMES],
  };
}

/** orbit-api as the phone shows it after refusing the file the owner wrote. */
function refusedOrbit(): EnvSetView {
  return setView({
    id: 'set-orbit',
    name: 'orbit-api',
    repo: 'orbit/api',
    role: 'outside',
    ownerLabel: 'Ben Okafor · Pixel 9',
    variableCount: 5,
    memberCount: 3,
    refusedNote: "orbit-api's history goes back further than this phone checks, so it didn't take the set. Ask Ben Okafor to start a fresh set with authdeck env init.",
  });
}

/** The problems a set shows in the error scenario, worded by envcore as the engine would. */
function sampleProblems(set: EnvSetView): EnvProblemView[] {
  const words = envFileProblemWords(
    { kind: 'unsigned-line', line: 14, name: 'DATABASE_URL' },
    { file: set.file, set: set.name, commit: '77b0e1d', where: 'phone' },
  );
  return [
    { id: 'p-file', kind: 'file', severity: 'error', title: words.title, text: words.message, hint: words.hint },
    {
      id: 'p-older',
      kind: 'older-copy',
      severity: 'warning',
      title: `${set.computerName} shows an older ${set.name}`,
      text: "Its file is at member list rev 6; this phone has seen rev 7. Releases use this phone's copy.",
      hint: `Pull the latest commit on ${set.computerName}.`,
    },
    {
      id: 'p-offline',
      kind: 'offline',
      severity: 'warning',
      title: `${set.computerName} is offline`,
      text: "Variables show as they were when this phone last read them. Changes wait on this phone and go out when it's back.",
    },
  ];
}

function initialState(): MockEnvState {
  return {
    status: 'open',
    sets: sampleSets(),
    incoming: [],
    ended: [],
    joinRequests: [CHEN_JOIN],
    join: null,
    personName: 'Maya Rao',
    ownRequests: [
      {
        setId: 'set-orbit',
        setName: 'orbit-api',
        computerName: COMPUTER,
        keyWords: ['canyon', 'pepper', 'blanket', 'orbit', 'sail', 'meadow'],
        madeAt: now() - DAY,
        ownerLabel: 'Ben Okafor · Pixel 9',
        ownerKeyWords: ['tunnel', 'amber', 'fossil', 'garden', 'quote', 'ripple'],
        ownerConfirmed: false,
      },
    ],
    agentTooOld: false,
    data: sampleData(),
    pushes: {},
  };
}

export const useMockEnv = create<MockEnvState>()(() => initialState());

const get = () => useMockEnv.getState();
const set = (patch: Partial<MockEnvState>) => useMockEnv.setState(patch);

function patchSet(setId: string, patch: Partial<EnvSetView>): void {
  set({ sets: get().sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) });
}

function patchData(setId: string, patch: Partial<SetData>): void {
  const data = get().data[setId];
  if (!data) throw new Error('That set is no longer on this phone.');
  set({ data: { ...get().data, [setId]: { ...data, ...patch } } });
}

function dataFor(setId: string): SetData {
  const data = get().data[setId];
  if (!data) throw new Error('That set is no longer on this phone.');
  return data;
}

function setFor(setId: string): EnvSetView {
  const found = get().sets.find((s) => s.id === setId);
  if (!found) throw new Error('That set is no longer on this phone.');
  return found;
}

function logChange(setId: string, text: string): void {
  const data = dataFor(setId);
  const item: EnvHistoryItemView = { commit: commit(`${setId}:${text}:${now()}`), time: now(), text, by: THIS_DEVICE, signed: true };
  patchData(setId, { history: [item, ...data.history] });
}

// ---------------------------------------------------------------------------
// Dotenv and checks
// ---------------------------------------------------------------------------

const NAME_HINT = envFileProblemWords({ kind: 'bad-name', line: 1, name: '' }, { file: '', set: '', where: 'phone' }).hint;

function checkVariable(name: string, value: string): string[] {
  const problems: string[] = [];
  if (!name) problems.push('Give the variable a name.');
  else if (!ENV_NAME_PATTERN.test(name)) problems.push(`${name} can't be a variable name. ${NAME_HINT}`);
  if (new TextEncoder().encode(value).length > ENV_LIMITS.valueBytes) problems.push(`The value is larger than ${ENV_LIMITS.valueBytes / 1024} KB.`);
  return problems;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, '\n') : inner;
  }
  return trimmed.replace(/\s+#.*$/, '');
}

function parseDotenv(text: string): { values: { name: string; value: string }[]; problems: string[] } {
  const values: { name: string; value: string }[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const body = line.trim().replace(/^export\s+/, '');
    if (!body || body.startsWith('#')) return;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      problems.push(`Line ${index + 1} has no NAME=value, so it was left out.`);
      return;
    }
    const name = body.slice(0, eq).trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      problems.push(`Line ${index + 1}: ${name} can't be a variable name, so it was left out.`);
      return;
    }
    const existing = values.findIndex((v) => v.name === name);
    if (existing >= 0) {
      problems.push(`${name} appears twice; the later line (${index + 1}) is used.`);
      values.splice(existing, 1);
    }
    values.push({ name, value: unquote(body.slice(eq + 1)) });
  });
  return { values, problems };
}

function putVariable(setId: string, name: string, value: string, previousName?: string): void {
  const data = dataFor(setId);
  const kept = data.variables.filter((v) => v.name !== previousName || previousName === name);
  const current = kept.find((v) => v.name === name);
  const next: EnvVariableView = { ...variable(name, (current?.version ?? 0) + 1, THIS_PERSON, 0) };
  const variables = current ? kept.map((v) => (v.name === name ? next : v)) : [...kept, next];
  const values = { ...data.values, [name]: value };
  if (previousName && previousName !== name) delete values[previousName];
  patchData(setId, { variables, values });
  patchSet(setId, { variableCount: variables.length });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const mockEnvActions: EnvActions = {
  detail(setId) {
    const view = get().sets.find((s) => s.id === setId);
    const data = get().data[setId];
    if (!view || !data) return null;
    return { set: view, variables: data.variables, members: data.members };
  },
  async history(setId, before) {
    await wait(300);
    const items = dataFor(setId).history;
    const start = before ? items.findIndex((i) => i.commit === before) + 1 : 0;
    const page = items.slice(start, start + HISTORY_PAGE);
    return { items: page, more: start + HISTORY_PAGE < items.length };
  },
  async reveal(setId, name) {
    await wait(120);
    const value = dataFor(setId).values[name];
    if (value === undefined) throw new Error(`${name} is no longer in this set.`);
    return value;
  },
  checkVariable,
  async saveVariable(setId, { name, value, previousName }) {
    await wait();
    const problems = checkVariable(name, value);
    if (problems.length > 0) throw new Error(problems[0]);
    const renamed = previousName && previousName !== name;
    const isNew = !previousName && !dataFor(setId).values[name];
    putVariable(setId, name, value, previousName);
    logChange(setId, renamed ? `Renamed ${previousName} to ${name}` : isNew ? `Added ${name}` : `Changed ${name}`);
  },
  parseDotenv,
  async addVariables(setId, values) {
    await wait();
    for (const { name, value } of values) putVariable(setId, name, value);
    logChange(setId, values.length === 1 ? `Added ${values[0]!.name}` : `Added ${values.length} variables`);
  },
  async deleteVariable(setId, name) {
    await wait();
    const data = dataFor(setId);
    const values = { ...data.values };
    delete values[name];
    const variables = data.variables.filter((v) => v.name !== name);
    patchData(setId, { variables, values });
    patchSet(setId, { variableCount: variables.length });
    logChange(setId, `Deleted ${name}`);
  },

  teammateSteps(setId) {
    const view = setFor(setId);
    return [
      `Join ${view.name} on AuthDeck:`,
      `1. Clone ${view.repo ?? 'the repo'} and run authdeck env init in it. Your phone makes its keys, and the command writes .authdeck/requests/<device>.json.`,
      '2. Commit it and push, or open a pull request.',
      `3. Once ${view.computerName} has the commit, I compare your name and six key words with you, then approve.`,
    ].join('\n');
  },
  async approveJoin(requestId) {
    await wait(400);
    const request = get().joinRequests.find((r) => r.id === requestId);
    if (!request) throw new Error('That request is no longer waiting.');
    const data = dataFor(request.setId);
    const added = member(`m-${requestId}`, request.label, 'member', 0, request.form);
    patchData(request.setId, { members: [...data.members, added] });
    const view = setFor(request.setId);
    patchSet(request.setId, { memberCount: view.memberCount + 1, joinRequestCount: Math.max(0, view.joinRequestCount - 1) });
    logChange(request.setId, `Added ${request.label.split(' · ')[0]}`);
    set({ joinRequests: get().joinRequests.filter((r) => r.id !== requestId) });
  },
  async declineJoin(requestId) {
    const request = get().joinRequests.find((r) => r.id === requestId);
    if (request) patchSet(request.setId, { joinRequestCount: Math.max(0, setFor(request.setId).joinRequestCount - 1) });
    set({ joinRequests: get().joinRequests.filter((r) => r.id !== requestId) });
  },
  async acceptOwnDeviceJoin(requestId) {
    await wait(600);
    set({ joinRequests: get().joinRequests.map((r) => (r.id === requestId ? { ...r, code: '304917' } : r)) });
  },
  async requestJoin(setId) {
    const view = setFor(setId);
    set({ join: { setId, setName: view.name, peerName: null, code: null, stage: 'waiting', expiresAt: now() + 5 * MIN } });
    await wait(1500);
    const join = get().join;
    if (join?.setId !== setId) return;
    set({ join: { ...join, peerName: 'Maya Rao · iPad mini', code: '582046', stage: 'compare' } });
    // The iPad approves after its person compares the codes.
    await wait(6000);
    const compared = get().join;
    if (compared?.setId !== setId || compared.stage !== 'compare') return;
    set({ join: { ...compared, stage: 'done' } });
    patchData(setId, { members: [member('m-maya-ipad', 'Maya Rao · iPad mini', 'owner', 6, 'tablet'), member('m-maya-pixel', THIS_DEVICE, 'member', 0)] });
    patchSet(setId, { role: 'member', ownerLabel: 'Maya Rao · iPad mini', memberCount: setFor(setId).memberCount + 1 });
  },
  cancelJoin() {
    set({ join: null });
  },
  async removeMember(setId, memberId) {
    await wait(700);
    const data = dataFor(setId);
    const removed = data.members.find((m) => m.id === memberId);
    if (!removed) throw new Error('That device is no longer a member.');
    patchData(setId, {
      members: data.members.filter((m) => m.id !== memberId),
      variables: data.variables.map((v) => ({ ...v, version: v.version + 1, by: THIS_PERSON, byMemberId: 'm-maya-pixel', time: now() })),
    });
    patchSet(setId, { memberCount: setFor(setId).memberCount - 1 });
    logChange(setId, `Removed ${removed.label} and made a new key`);
    return { rotate: data.variables.map((v) => v.name) };
  },

  async answer(requestId, answer) {
    await wait(300);
    const request = get().incoming.find((r) => r.id === requestId);
    if (!request) throw new Error('That request already ended.');
    set({ incoming: get().incoming.filter((r) => r.id !== requestId) });
    if (request.kind === 'push' && answer === 'approve' && request.setId) {
      // The diff is worked out while signing, and comes back with the answer.
      const push = get().pushes[requestId];
      const changes = push?.changes ?? [];
      for (const change of changes) {
        if (change.change === 'remove') await mockEnvActions.deleteVariable(request.setId, change.name);
        else putVariable(request.setId, change.name, push!.values.find((v) => v.name === change.name)?.value ?? '');
      }
      return { changes };
    }
    if (answer === 'grant' && request.setId) {
      patchSet(request.setId, {
        grant: { grantId: `g-${requestId}`, computerName: request.computerName, endsAt: now() + GRANT_MS, by: THIS_DEVICE, usedBy: [request.command] },
        lastReleasedAt: now(),
      });
    } else if (answer === 'once' && request.setId) {
      patchSet(request.setId, { lastReleasedAt: now() });
    }
    return { changes: null };
  },
  dismissEnded(requestId) {
    set({ ended: get().ended.filter((e) => e.id !== requestId) });
  },
  pushedValue(requestId, name) {
    return get().pushes[requestId]?.values.find((v) => v.name === name)?.value ?? null;
  },
  async endGrant(setId) {
    await wait(200);
    patchSet(setId, { grant: null });
  },
  async becomeOwner(setId, phrase) {
    await wait(700);
    const view = setFor(setId);
    if (phrase.join(' ') !== MOCK_OWNER_PHRASE.join(' ')) {
      throw new Error(`Those words aren't the recovery phrase of ${view.name}'s owner. Check them against the paper, then try again.`);
    }
    const data = dataFor(setId);
    const members = data.members.length > 0 ? data.members : [member('m-maya-pixel', THIS_DEVICE, 'member', 0)];
    // Taking over takes every other member out: they ask to join again.
    const others = members.filter((m) => !m.thisDevice);
    const self = members.find((m) => m.thisDevice) ?? member('m-maya-pixel', THIS_DEVICE, 'owner', 0);
    patchData(setId, { members: [{ ...self, role: 'owner' }] });
    patchSet(setId, { role: 'owner', ownerLabel: THIS_DEVICE, memberCount: 1 });
    logChange(setId, 'Made this phone the owner with the recovery phrase');
    return { removed: others.map((m) => m.label), rotate: data.variables.map((v) => v.name) };
  },
  async fixOldKeyLines(setId, keep, reviewedNames) {
    await wait(600);
    const problem = setFor(setId).problems.find((p) => p.kind === 'epoch');
    const names = problem?.names ?? [];
    if (names.join('\n') !== reviewedNames.join('\n')) {
      throw new Error(`The values under the old key changed since this sheet showed them. Check the new list, then choose again.`);
    }
    if (!keep) {
      const data = dataFor(setId);
      const variables = data.variables.filter((v) => !names.includes(v.name));
      patchData(setId, { variables });
      patchSet(setId, { variableCount: variables.length });
    }
    patchSet(setId, { problems: setFor(setId).problems.filter((p) => p.kind !== 'epoch') });
    logChange(setId, keep ? `Encrypted ${names.length} old-key values again` : `Removed ${names.length} old-key values`);
    // Dropped values stay readable in git history to anyone who could read them: rotate them too.
    return { rotate: [...names] };
  },
  async cancelOwnRequest(setId) {
    await wait(300);
    // Forgets the request; the set stays listed as one this phone isn't in.
    set({ ownRequests: get().ownRequests.filter((r) => r.setId !== setId) });
  },
  async confirmOwnerWords(setId, shownWords) {
    await wait(300);
    const request = get().ownRequests.find((r) => r.setId === setId);
    if (!request) throw new Error('That request is no longer waiting.');
    if (request.ownerKeyWords.join(' ') !== shownWords.join(' ')) {
      throw new Error("The owner's words changed while this was open. Compare the new words below.");
    }
    set({ ownRequests: get().ownRequests.map((r) => (r.setId === setId ? { ...r, ownerConfirmed: true } : r)) });
  },
  async deleteRemovedSet(setId) {
    await wait();
    if (setFor(setId).role !== 'removed') throw new Error('Only a set this phone was removed from can be deleted here.');
    const data = { ...get().data };
    delete data[setId];
    set({ sets: get().sets.filter((s) => s.id !== setId), data });
  },
  async setPersonName(name) {
    await wait();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 40) throw new Error('Your name takes 1 to 40 characters.');
    set({ personName: trimmed });
  },
};

// ---------------------------------------------------------------------------
// Scenarios, for screenshots and tests
// ---------------------------------------------------------------------------

export type MockEnvScenario = 'full' | 'empty' | 'loading' | 'locked' | 'errors' | 'agent-too-old' | 'refused';

export function mockEnvScenario(scenario: MockEnvScenario): void {
  const base = initialState();
  switch (scenario) {
    case 'full':
      useMockEnv.setState(base, true);
      return;
    case 'empty':
      useMockEnv.setState({ ...base, sets: [], joinRequests: [], ownRequests: [], data: {} }, true);
      return;
    case 'loading':
    case 'locked':
      useMockEnv.setState({ ...base, status: scenario }, true);
      return;
    case 'errors':
      useMockEnv.setState(
        {
          ...base,
          sets: base.sets.map((s) => {
            if (s.id === 'set-acme-api') return { ...s, computerOnline: false, grant: null, syncedAt: now() - 28 * MIN, problems: [...sampleProblems(s), epochProblem()] };
            if (s.id === 'set-ledgerline') return { ...s, problems: [epochProblem()] };
            return s;
          }),
        },
        true,
      );
      return;
    case 'agent-too-old':
      useMockEnv.setState({ ...base, agentTooOld: true }, true);
      return;
    case 'refused':
      // The owner added this phone to orbit-api, but the phone's checks refused the file.
      useMockEnv.setState(
        {
          ...base,
          sets: [...base.sets, refusedOrbit()],
          ownRequests: base.ownRequests.map((r) => ({ ...r, ownerConfirmed: true })),
          data: { ...base.data, 'set-orbit': { variables: [], members: [], values: {}, history: [] } },
        },
        true,
      );
  }
}

export type MockRequestKind = EnvRequestView['kind'] | 'problem';

function requestBase(kind: EnvRequestView['kind'], setName = 'acme-api'): EnvRequestView {
  return {
    id: `req-${kind}-${now()}`,
    kind,
    computerName: COMPUTER,
    setId: kind === 'create' ? null : `set-${setName}`,
    setName,
    askedAt: now(),
    expiresAt: now() + REQUEST_MS,
    needsUnlock: get().status === 'locked',
    command: '',
    folder: `~/code/${setName}`,
    startedIn: 'Terminal · zsh',
    target: null,
    variableCount: 12,
    changes: null,
    olderOnComputer: false,
    problem: null,
    file: kind === 'create' ? null : `.authdeck/${setName}.env`,
  };
}

/** Puts a computer's request on screen, as if MacBook Pro just asked. */
export function mockEnvRequest(kind: MockRequestKind): EnvRequestView {
  const request = buildRequest(kind);
  if (request.kind === 'push') {
    const values = [
      { name: 'FEATURE_FLAGS_URL', value: 'https://flags.acme.dev/api' },
      { name: 'STRIPE_WEBHOOK_SECRET', value: 'whsec_N7v2Kp9Qa4Lm0Zx8' },
      { name: 'NODE_OPTIONS', value: '--require ./tracing.js' },
    ];
    const changes: EnvChangeView[] = [
      { name: 'FEATURE_FLAGS_URL', change: 'add', loadsCode: false },
      { name: 'STRIPE_WEBHOOK_SECRET', change: 'change', loadsCode: false },
      { name: 'NODE_OPTIONS', change: 'change', loadsCode: true },
      { name: 'LEGACY_API_KEY', change: 'remove', loadsCode: false },
    ];
    set({ pushes: { ...get().pushes, [request.id]: { values, changes } } });
  }
  set({ incoming: [...get().incoming, request] });
  return request;
}

function buildRequest(kind: MockRequestKind): EnvRequestView {
  switch (kind) {
    case 'run':
      return { ...requestBase('run'), command: 'npm run dev' };
    case 'pull':
      return { ...requestBase('pull'), command: 'authdeck env pull', startedIn: null, target: { path: '~/code/acme-api/.env', gitignored: false } };
    case 'push':
      return { ...requestBase('push'), command: 'authdeck env push .env.local --prune', variableCount: 11 };
    case 'create':
      return { ...requestBase('create', 'orbit-worker'), command: 'authdeck env init --from .env', variableCount: 8 };
    case 'join-keys':
      return { ...requestBase('join-keys', 'ledgerline-web'), command: 'authdeck env init', variableCount: 0 };
    case 'problem': {
      const view = get().sets.find((s) => s.id === 'set-acme-api') ?? sampleSets()[0]!;
      const [file] = sampleProblems(view);
      return { ...requestBase('run'), command: 'npm run dev', problem: file! };
    }
  }
}

/** Puts an own-device join request on screen, as if the iPad asked to join pebble. */
export function mockEnvOwnDeviceJoin(): void {
  set({ joinRequests: [...get().joinRequests.filter((r) => r.id !== IPAD_JOIN.id), { ...IPAD_JOIN, expiresAt: now() + 5 * MIN }] });
}

/** Ends a waiting request as if another device answered it, it ran out, or the command stopped. */
export function mockEnvEndRequest(requestId: string, reason: EnvEndedRequestView['reason'], by: string | null = null): void {
  const ended: EnvEndedRequestView = { id: requestId, reason, by: reason === 'answered' ? by : null, endedAt: now() };
  set({ incoming: get().incoming.filter((r) => r.id !== requestId), ended: [ended, ...get().ended] });
}
