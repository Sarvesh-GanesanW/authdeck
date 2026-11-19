/**
 * An in-memory vault with sample accounts, for building and screenshotting screens without a
 * paired computer or real keys. useVault returns it when mock mode is on (see ./useVault).
 * Codes are fake: stable within a period, never real one-time passwords.
 */
import { create } from 'zustand';
import type {
  AccountView,
  CodeView,
  DeviceView,
  HistoryItem,
  ImportPreview,
  JoinRequestView,
  JoinState,
  NewAccount,
  VaultApi,
  VaultSnapshot,
} from './contract';
import { unpairSentence } from './engine/unpair';

const MIN = 60_000;
const DAY = 86_400_000;
const now = () => Date.now();

const sampleAccounts: AccountView[] = [
  { id: 'a1', issuer: 'GitHub', label: 'ada-lovelace', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: null },
  { id: 'a2', issuer: 'AWS', label: 'prod-admin', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: null },
  { id: 'a3', issuer: 'Google', label: 'ada@example.com', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: null },
  { id: 'a4', issuer: 'Stripe', label: 'billing@studio', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: null },
  { id: 'a5', issuer: 'npm', label: 'ada', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: null },
  { id: 'a6', issuer: 'Cloudflare', label: 'studio account', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: null },
  { id: 'a7', issuer: 'Sentry', label: 'platform', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, team: 'Platform team' },
  { id: 'a8', issuer: 'Steam', label: 'ada_plays', type: 'steam', algorithm: 'SHA1', digits: 5, period: 30, team: null },
];

const sampleDevices: DeviceView[] = [
  {
    id: 'd1',
    name: 'Xiaomi Pad 7',
    keyWords: 'amber orbit tulip',
    thisDevice: true,
    role: 'admin',
    addedAt: now() - 3 * DAY,
    lastHeardAt: now() - 20 * MIN,
    signedTwoHistories: false,
  },
  {
    id: 'd2',
    name: 'Pixel 8',
    keyWords: 'cedar lamp violin',
    thisDevice: false,
    role: 'admin',
    addedAt: now() - DAY,
    lastHeardAt: now() - 2 * DAY,
    signedTwoHistories: false,
  },
];

const sampleHistory: HistoryItem[] = [
  { id: 'h1', time: now() - 20 * MIN, text: 'Added Steam', by: 'Xiaomi Pad 7', status: 'applied' },
  {
    id: 'h0',
    time: now() - 95 * MIN,
    text: 'Unsigned change',
    by: 'Unknown device',
    status: 'rejected',
    reason: 'None of your devices signed it, so it was ignored and nothing changed.',
  },
  { id: 'h2', time: now() - 26 * 60 * MIN, text: 'Shared Sentry with Platform team', by: 'Pixel 8', status: 'applied' },
  { id: 'h3', time: now() - 27 * 60 * MIN, text: 'Trusted Pixel 8', by: 'Xiaomi Pad 7', status: 'applied' },
  { id: 'h4', time: now() - 2 * DAY, text: 'Renamed AWS account', by: 'Xiaomi Pad 7', status: 'applied' },
];

const SAMPLE_PHRASE = 'guard tank tongue pass mask doll joy bargain dragon hole slide depend'.split(' ');
const STEAM = '23456789BCDFGHJKMNPQRTVWXY';

function fakeCode(account: AccountView, at: number): CodeView {
  const period = account.period || 30;
  const step = Math.floor(at / 1000 / period);
  let h = 2166136261;
  for (const ch of `${account.id}:${step}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const code =
    account.type === 'steam'
      ? Array.from({ length: 5 }, (_, i) => STEAM[(h >>> (i * 5)) % STEAM.length]).join('')
      : String(h % 10 ** account.digits).padStart(account.digits, '0');
  const secondsLeft = account.type === 'hotp' ? 0 : period - (Math.floor(at / 1000) % period);
  return { code, secondsLeft, period: account.type === 'hotp' ? 0 : period };
}

function preview(text: string): ImportPreview {
  if (text.startsWith('otpauth-migration://')) {
    return {
      accounts: [
        { issuer: 'Dropbox', label: 'ada@example.com', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
        { issuer: 'Figma', label: 'ada', secret: 'JBSWY3DPEHPK3PXQ', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
      ],
      problems: [],
      batches: { scanned: 1, total: 2 },
    };
  }
  if (text.startsWith('otpauth://')) {
    return {
      accounts: [{ issuer: 'GitHub', label: 'ada-lovelace', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 }],
      problems: [],
    };
  }
  return { accounts: [], problems: ["That QR code isn't a 2FA setup code. Look for the QR code on the site's two-factor setup page."] };
}

type MockState = VaultSnapshot & { join: JoinState | null; incoming: JoinRequestView[] };

const initial: MockState = {
  status: 'open',
  name: 'My vault',
  accounts: sampleAccounts,
  devices: sampleDevices,
  history: sampleHistory,
  caughtChanges: [],
  voidedChanges: [],
  chainOk: true,
  rollbackWarning: null,
  recovery: { savedAt: now() - 3 * DAY },
  storage: { computerName: 'MacBook Pro', path: '~/.authdeck/vault', syncedAt: Date.now() },
  lastChangeAt: now() - 20 * MIN,
  appLock: true,
  autoLockMs: 5 * MIN,
  locksAt: now() + 4 * MIN,
  computerOnline: true,
  warnings: [],
  secretsPaused: false,
  removed: null,
  heldRemoval: false,
  appLockBlocked: null,
  join: null,
  incoming: [],
};

export const useMockVault = create<MockState>()(() => initial);

const set = (patch: Partial<MockState>) => useMockVault.setState(patch);
const get = () => useMockVault.getState();
const wait = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));

export const mockActions: Omit<VaultApi, keyof MockState> = {
  async createVault() {
    await wait();
    set({ status: 'open', accounts: [], devices: [sampleDevices[0]], history: [], recovery: { savedAt: null } });
    return { phrase: SAMPLE_PHRASE, flow: 'mock' };
  },
  async confirmRecoverySaved() {
    set({ recovery: { savedAt: now() } });
    return { saved: true };
  },
  endRecoveryFlow() {},
  async newRecoveryPhrase() {
    await wait();
    set({ recovery: { savedAt: null } });
    return { phrase: SAMPLE_PHRASE, flow: 'mock' };
  },
  async replaceVaultWithoutPhrase() {
    await wait();
    return { phrase: SAMPLE_PHRASE, flow: 'mock' };
  },
  async unlock() {
    await wait();
    set({ status: 'open', accounts: sampleAccounts, locksAt: now() + get().autoLockMs });
  },
  async unlockWithPhrase() {
    await wait();
    set({ status: 'open', accounts: sampleAccounts, locksAt: now() + get().autoLockMs, appLockBlocked: null });
  },
  async requireUnlock() {
    const { appLock, status } = get();
    if (!appLock || status === 'open' || status === 'none') return;
    await mockActions.unlock();
  },
  lock() {
    set({ status: 'locked', accounts: [], locksAt: null });
  },
  async setAppLock(on) {
    set({ appLock: on });
  },
  setAutoLock(ms) {
    set({ autoLockMs: ms });
  },
  code(accountId, at = now()) {
    const account = get().accounts.find((a) => a.id === accountId);
    return account && get().status === 'open' ? fakeCode(account, at) : null;
  },
  parseQr: preview,
  checkAccount(a: NewAccount) {
    const problems: string[] = [];
    if (!a.secret.replace(/[\s=]/g, '').match(/^[A-Za-z2-7]{16,}$/)) problems.push('The key should be at least 16 letters A–Z and digits 2–7.');
    if (!a.issuer.trim() && !a.label.trim()) problems.push('Give the account a name so you can tell it apart.');
    return problems;
  },
  async addAccounts(accounts) {
    await wait();
    const added = accounts.map((a, i) => ({
      id: `n${now()}${i}`,
      issuer: a.issuer,
      label: a.label,
      type: a.type,
      algorithm: a.algorithm,
      digits: a.digits,
      period: a.period,
      team: null,
    }));
    set({ accounts: [...get().accounts, ...added], lastChangeAt: now() });
    return added.map((a) => a.id);
  },
  async renameAccount(id, issuer, label) {
    set({ accounts: get().accounts.map((a) => (a.id === id ? { ...a, issuer, label } : a)) });
  },
  async deleteAccount(id) {
    set({ accounts: get().accounts.filter((a) => a.id !== id) });
  },
  async typeCode() {
    await wait(150);
  },
  async renameDevice(id, name) {
    set({ devices: get().devices.map((d) => (d.id === id ? { ...d, name } : d)) });
  },
  async removeDevice(id) {
    await wait();
    const name = get().devices.find((d) => d.id === id)?.name ?? 'The device';
    set({ devices: get().devices.filter((d) => d.id !== id) });
    return { accountsToReset: get().accounts.filter((a) => a.team === null), unpairNote: unpairSentence(name, get().storage.computerName, null) };
  },
  async reapplyCaughtChanges(ids) {
    await wait();
    set({ caughtChanges: get().caughtChanges.filter((c) => !ids.includes(c.id)) });
  },
  async dismissVoidedChanges(ids) {
    set({ voidedChanges: get().voidedChanges.filter((c) => !ids.includes(c.id)) });
  },
  async dismissCaughtChanges(ids) {
    set({ caughtChanges: get().caughtChanges.filter((c) => !ids.includes(c.id)) });
  },
  async requestJoin() {
    set({ join: { role: 'new', requestId: 'r1', peerName: null, code: null, stage: 'waiting', expiresAt: now() + 5 * MIN } });
    await wait(1200);
    set({ join: { ...get().join!, code: '471290', stage: 'compare', peerName: 'Xiaomi Pad 7', peerKeyWords: 'amber orbit tulip', vaultName: 'My vault' } });
  },
  cancelJoin() {
    set({ join: null });
  },
  async acceptJoinRequest(requestId) {
    await wait();
    set({ incoming: get().incoming.map((r) => (r.id === requestId ? { ...r, code: '471290' } : r)) });
  },
  async approveJoin(requestId) {
    await wait();
    set({ incoming: get().incoming.filter((r) => r.id !== requestId) });
  },
  denyJoin(requestId) {
    set({ incoming: get().incoming.filter((r) => r.id !== requestId) });
  },
  cancelRestore() {},
  async restoreWithPhrase() {
    await wait(800);
    set({ status: 'open', accounts: sampleAccounts });
    return { replacedAt: null, warning: null };
  },
  async deleteRemovedVault() {
    await wait();
    set({ status: 'none', accounts: [], devices: [], history: [], removed: null, heldRemoval: false, secretsPaused: false });
  },
};

/** For screenshots: puts a join request on screen as if Pixel 8 just asked. */
export function mockIncomingRequest(): void {
  set({ incoming: [{ id: 'r1', deviceName: 'Pixel 8', code: '471290', expiresAt: now() + 4.5 * MIN, keyWords: 'cedar lamp violin' }] });
}

/** For screenshots: the vault in a given state ('none', 'locked', 'open'). */
export function mockStatus(status: VaultSnapshot['status']): void {
  set({ status, accounts: status === 'open' ? sampleAccounts : [], locksAt: status === 'open' ? now() + 4 * MIN : null });
}
