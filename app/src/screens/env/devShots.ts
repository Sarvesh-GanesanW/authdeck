/**
 * The dev-shots switch: a debug build started with EXPO_PUBLIC_AUTHDECK_ENV_SHOTS=1 shows the
 * sample sets (./mock) instead of the engine, so every env screen and state can be put on an
 * emulator and screenshotted. It polls http://localhost:8799/shot.json (through `adb reverse`)
 * for the state to show, for example {"n": 3, "set": "set-acme-api", "variable": "add"}; a new
 * `n` applies the rest. Release builds never read the switch.
 */
import { useAuthUi } from '../../auth/ui';
import { envSheets } from './sheetState';
import { oldKeyRotate, removedRotate, takeOverRotate } from './view';
import { mockEnvEndRequest, mockEnvOwnDeviceJoin, mockEnvRequest, mockEnvScenario, useMockEnv, type MockEnvScenario, type MockRequestKind } from './mock';

function isDevBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

// Expo inlines EXPO_PUBLIC_* only where they are written out in full like this.
export const ENV_SHOTS = isDevBuild() && process.env.EXPO_PUBLIC_AUTHDECK_ENV_SHOTS === '1';

const SHOT_URL = 'http://localhost:8799/shot.json';
const POLL_MS = 1000;

interface Shot {
  n: number;
  scenario?: MockEnvScenario;
  vault?: boolean;
  set?: string;
  variable?: 'add' | string;
  addMember?: boolean;
  becomeOwner?: boolean;
  removed?: boolean;
  takeOver?: boolean;
  oldKeyResult?: 'keep' | 'drop';
  oldKey?: boolean;
  confirm?: boolean;
  review?: string;
  ownJoin?: boolean;
  ownerWords?: boolean;
  request?: MockRequestKind;
  locked?: boolean;
  end?: 'answered' | 'expired' | 'cancelled';
  join?: 'waiting' | 'compare' | 'done' | 'failed' | 'expired';
  noName?: boolean;
}

function applyShot(shot: Shot): void {
  envSheets.closeAll();
  mockEnvScenario(shot.scenario ?? 'full');
  if (shot.noName) useMockEnv.setState({ personName: null });
  if (shot.vault !== false) useAuthUi.getState().open('vault');
  if (shot.set) envSheets.openSet(shot.set);
  if (shot.variable) envSheets.openVariable(shot.variable === 'add' ? { mode: 'add' } : { mode: 'edit', name: shot.variable });
  if (shot.addMember) envSheets.setAddMember(true);
  if (shot.becomeOwner) envSheets.setBecomeOwner(true);
  if (shot.oldKey) envSheets.setOldKey(true);
  if (shot.removed) envSheets.showRotate(removedRotate('Ben Okafor · Pixel 9', ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY']));
  if (shot.takeOver) envSheets.showRotate(takeOverRotate('ledgerline', ['Ben Okafor · Pixel 9', 'Lin Park · Pixel 8'], ['DATABASE_URL', 'KAFKA_SASL_PASSWORD', 'PLAID_SECRET']));
  if (shot.oldKeyResult) envSheets.showRotate(oldKeyRotate(shot.oldKeyResult === 'keep', ['STRIPE_SECRET_KEY', 'POSTMARK_TOKEN'], ['STRIPE_SECRET_KEY', 'POSTMARK_TOKEN']));
  if (shot.confirm) {
    envSheets.confirm({ title: 'Delete REDIS_URL?', message: 'REDIS_URL is removed from acme-api for every member.', confirmLabel: 'Delete', danger: true, action: async () => undefined });
  }
  if (shot.review) envSheets.reviewJoin(shot.review);
  if (shot.ownJoin) mockEnvOwnDeviceJoin();
  if (shot.ownerWords) envSheets.checkOwnerWords('set-orbit');
  if (shot.request) showRequest(shot);
  if (shot.join) showJoin(shot.join);
}

function showRequest(shot: Shot): void {
  const request = mockEnvRequest(shot.request!);
  if (shot.locked) useMockEnv.setState({ incoming: useMockEnv.getState().incoming.map((r) => ({ ...r, needsUnlock: true })) });
  if (shot.end) setTimeout(() => mockEnvEndRequest(request.id, shot.end!, "Maya's iPad"), 300);
}

function showJoin(stage: NonNullable<Shot['join']>): void {
  useMockEnv.setState({
    join: {
      setId: 'set-acme-web',
      setName: 'acme-web',
      peerName: 'Maya Rao · iPad mini',
      code: stage === 'compare' ? '582046' : null,
      stage,
      expiresAt: Date.now() + 4 * 60_000,
      error: stage === 'failed' ? "The iPad declined, so this phone wasn't added." : undefined,
    },
  });
}

let lastShot = -1;

async function poll(): Promise<void> {
  const response = await fetch(SHOT_URL, { cache: 'no-store' });
  if (!response.ok) return;
  const shot = (await response.json()) as Shot;
  if (shot.n === lastShot) return;
  lastShot = shot.n;
  applyShot(shot);
}

if (ENV_SHOTS) {
  // The shot server is only up while shots are being taken; until then there is nothing to show.
  setInterval(() => void poll().catch(() => undefined), POLL_MS);
}
