/**
 * Approving a new device, both sides, over the computer's vault.join.* relay. The relay is
 * untrusted; the check code and the step order in ./joinSteps keep it honest. Nonces live only
 * in memory and only for the request's lifetime.
 */
import type { JoinRequestView, JoinState } from '../contract';
import type { Events, VaultJoinRequest } from '../../protocol';
import type { RandomBytes } from '../../vault/bytes';
import { fromBase64Url } from '../../vault/bytes';
import type { DevicePublicKeys } from '../../vault/build';
import { keyWords, type DeviceKeys } from '../../vault/crypto';
import {
  approverCheckCode,
  createJoinChallenge,
  createJoinRequest,
  createJoinReveal,
  newDeviceCheckCode,
  readJoinRequest,
  type JoinChallenge,
  type JoinRequest,
} from '../../vault/approval';
import { isLive, nextApproverStep, nextNewDeviceStep, stageFor, type ApproverStep, type NewDeviceStep } from './joinSteps';
import { joinEndedSentence } from './sentences';

/** What the controller needs from the engine and the connection. */
export interface JoinHost {
  random: RandomBytes;
  now(): number;
  request<M extends 'vault.join.request' | 'vault.join.challenge' | 'vault.join.reveal' | 'vault.join.finish' | 'vault.join.cancel'>(
    method: M,
    params: import('../../protocol').Methods[M]['params'],
  ): Promise<import('../../protocol').Methods[M]['result']>;
  /** New device: its keys (made on first use, new when a vault removed them). Throws when this device is already in a vault. */
  keysForJoin(): Promise<DeviceKeys>;
  /** New device: replaces its stored keys with new ones, after a join left the old ones tied to a vault it isn't in. */
  renewJoinKeys(): Promise<void>;
  /**
   * New device: reads the vault the challenge named, checks it holds this device's own keys added
   * by the device it compared codes with, writes device.hello, opens it. Throws JoinIntercepted
   * when the vault shows anything else, and JoinNotApproved when it holds no approval this device can use.
   */
  adoptVault(device: DeviceKeys, challenge: JoinChallenge): Promise<void>;
  /** True when this device is an admin of an existing vault, so it may answer requests. */
  canApprove(): boolean;
  /** Approver: this device's keys and what it offers, unlocking the vault first if needed. */
  approverOffer(): Promise<ApproverOffer>;
  /** Approver: writes device.add and makes sure the folder has it. Returns the vault id. */
  addDevice(device: DevicePublicKeys, name: string): Promise<string>;
  publish(view: { join: JoinState | null; incoming: JoinRequestView[] }): void;
}

export interface ApproverOffer {
  device: DeviceKeys;
  vaultId: string;
  vaultName: string;
  deviceName: string;
}

/** The vault the new device was given is not the one it compared codes for. */
export class JoinIntercepted extends Error {}

/** The approver said it finished, but the vault holds no approval this device can use. */
export class JoinNotApproved extends Error {}

/** Why a join is stuck: approved with keys that aren't this device's, or with no usable approval. */
export type JoinStuck = 'intercepted' | 'unapproved';

function stuckBy(err: unknown): JoinStuck | undefined {
  if (err instanceof JoinIntercepted) return 'intercepted';
  if (err instanceof JoinNotApproved) return 'unapproved';
  return undefined;
}

interface NewDeviceJoin {
  requestId: string;
  step: NewDeviceStep;
  device: DeviceKeys;
  /** The exact request sent: the code is computed over it. */
  request: JoinRequest;
  nonce: Uint8Array;
  challenge: JoinChallenge | null;
  code: string | null;
  expiresAt: number;
  error?: string;
  stuck?: JoinStuck;
}

interface ApproverJoin {
  requestId: string;
  step: ApproverStep;
  /** The exact request checked: device.add is built from it and nothing else. */
  request: VaultJoinRequest;
  challenge: JoinChallenge | null;
  code: string | null;
  expiresAt: number;
  error?: string;
}

const NOT_ANSWERABLE = 'This request has already been answered or has ended.';
/** Stopped join attempts are counted over this window (warnings.ts warns past a few). */
export const JOIN_ATTEMPT_WINDOW_MS = 60 * 60_000;

/** A device's three key words from its base64url signing key; empty when the key is damaged. */
function wordsOf(ed: string): string {
  try {
    return keyWords(fromBase64Url(ed)).join(' ');
  } catch {
    return '';
  }
}

export class JoinController {
  private mine: NewDeviceJoin | null = null;
  private requests = new Map<string, ApproverJoin>();
  /** The request this device chose to answer; shown as `join` with role 'approver'. */
  private answering: string | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Request id -> when a request this device saw ended without being approved. */
  private stopped = new Map<string, number>();
  /** A stuck join left this device's keys tied to a vault; the next request makes new ones first. */
  private keysRetired = false;
  /** The renewal in flight, shared so a request never loads keys while new ones are being stored. */
  private renewal: Promise<void> | null = null;

  constructor(private readonly host: JoinHost) {}

  /** Join requests this device saw stopped (cancelled, failed, denied, expired) in the last hour. */
  stoppedAttempts(): number {
    const since = this.host.now() - JOIN_ATTEMPT_WINDOW_MS;
    for (const [requestId, at] of this.stopped) if (at < since) this.stopped.delete(requestId);
    return this.stopped.size;
  }

  // --- New device -------------------------------------------------------------------------

  async requestJoin(deviceName: string): Promise<void> {
    this.cancel();
    await this.renewRetiredKeys();
    const device = await this.host.keysForJoin();
    const { request, nonce } = createJoinRequest(device, deviceName.trim() || 'New device', this.host.random);
    const { requestId, expiresAt } = await this.host.request('vault.join.request', { request });
    this.mine = { requestId, step: 'asked', device, request, nonce, challenge: null, code: null, expiresAt };
    this.expireAt(requestId, expiresAt);
    this.publish();
  }

  private async onChallenged({ requestId, challenge }: Events['vault.join.challenged']): Promise<void> {
    const join = this.mine;
    if (!join || join.requestId !== requestId) return;
    const next = nextNewDeviceStep(join.step, 'challenged');
    if (!next) return;
    let code: string;
    try {
      code = newDeviceCheckCode(join.request, join.nonce, challenge);
    } catch {
      this.failMine('The other device sent a damaged answer. Start again.', true);
      return;
    }
    // Reveal only now: the challenge, and with it the approver's nonce, has arrived.
    Object.assign(join, { step: next, challenge, code });
    this.publish();
    try {
      await this.host.request('vault.join.reveal', { requestId, reveal: createJoinReveal(join.nonce) });
    } catch (err) {
      this.failMine((err as Error).message, false);
    }
  }

  private async onFinished({ requestId, approved, vaultId }: Events['vault.join.finished']): Promise<void> {
    const join = this.mine;
    if (!join || join.requestId !== requestId) return;
    if (!approved) {
      const next = nextNewDeviceStep(join.step, 'refused');
      if (next) this.failMine("The other device said the codes didn't match, so this device wasn't added.", false);
      return;
    }
    const next = nextNewDeviceStep(join.step, 'finished');
    if (!next || !join.challenge) return;
    if (vaultId !== join.challenge.vault) {
      await this.failStuck(
        'Something between the two devices changed the join: the computer named a different vault than the one the other device offered.',
        'intercepted',
      );
      return;
    }
    try {
      await this.host.adoptVault(join.device, join.challenge);
      join.step = next;
      this.clearTimer(requestId);
      this.publish();
    } catch (err) {
      const stuck = stuckBy(err);
      if (stuck) await this.failStuck((err as Error).message, stuck);
      else this.failMine((err as Error).message, false);
    }
  }

  private failMine(error: string, tellRelay: boolean, stuck?: JoinStuck): void {
    const join = this.mine;
    if (!join) return;
    if (tellRelay) this.sendCancel(join.requestId);
    Object.assign(join, { step: 'failed', error, stuck });
    this.clearTimer(join.requestId);
    this.publish();
  }

  /**
   * A stuck join: the vault may list this device's id with keys or an approval it can't use, so
   * those keys are never offered again. New ones are made now; if that fails, before the next request.
   */
  private async failStuck(error: string, stuck: JoinStuck): Promise<void> {
    this.keysRetired = true;
    this.failMine(error, false, stuck);
    await this.renewRetiredKeys().catch(() => undefined);
  }

  private renewRetiredKeys(): Promise<void> {
    if (!this.keysRetired) return Promise.resolve();
    this.renewal ??= this.host
      .renewJoinKeys()
      .then(() => {
        this.keysRetired = false;
      })
      .finally(() => {
        this.renewal = null;
      });
    return this.renewal;
  }

  // --- Approver ---------------------------------------------------------------------------

  private onRequested({ requestId, request, expiresAt }: Events['vault.join.requested']): void {
    if (!this.host.canApprove() || expiresAt <= this.host.now()) return;
    try {
      readJoinRequest(request);
    } catch {
      return;
    }
    // The request carries the commitment, so answering it is the first allowed step.
    this.requests.set(requestId, { requestId, step: 'offered', request, challenge: null, code: null, expiresAt });
    this.expireAt(requestId, expiresAt);
    this.publish();
  }

  async accept(requestId: string): Promise<void> {
    const join = this.requests.get(requestId);
    const next = join && nextApproverStep(join.step, 'accept');
    if (!join || !next) throw new Error(NOT_ANSWERABLE);
    const offer = await this.host.approverOffer();
    if (join.step !== 'offered') throw new Error(NOT_ANSWERABLE);
    const { challenge } = createJoinChallenge(offer.device, offer, this.host.random);
    Object.assign(join, { step: next, challenge });
    this.answering = requestId;
    this.publish();
    try {
      await this.host.request('vault.join.challenge', { requestId, challenge });
    } catch (err) {
      this.endRequest(requestId, 'failed', (err as Error).message);
      throw err;
    }
  }

  private async onRevealed({ requestId, reveal }: Events['vault.join.revealed']): Promise<void> {
    const join = this.requests.get(requestId);
    const next = join && nextApproverStep(join.step, 'revealed');
    if (!join || !next || !join.challenge) return;
    let code: string;
    try {
      code = approverCheckCode(join.request, join.challenge, reveal);
    } catch (err) {
      this.sendCancel(requestId);
      this.endRequest(requestId, 'failed', (err as Error).message);
      return;
    }
    Object.assign(join, { step: next, code });
    this.publish();
  }

  async approve(requestId: string): Promise<void> {
    const join = this.requests.get(requestId);
    const next = join && nextApproverStep(join.step, 'approve');
    if (!join) throw new Error(NOT_ANSWERABLE);
    if (!next || !join.challenge) throw new Error('Wait until both devices show the code, then approve.');
    const vaultId = await this.host.addDevice(readJoinRequest(join.request), join.request.name);
    if (vaultId !== join.challenge.vault) throw new Error('This device left the vault it offered while the codes were compared. Start again.');
    await this.host.request('vault.join.finish', { requestId, approved: true, vaultId });
    this.endRequest(requestId, next);
  }

  deny(requestId: string): void {
    const join = this.requests.get(requestId);
    if (!join || !nextApproverStep(join.step, 'deny')) return;
    // Before answering, the request may still go to another device: just stop showing it here.
    if (join.step === 'revealed') void this.host.request('vault.join.finish', { requestId, approved: false }).catch(() => undefined);
    else if (join.step === 'challenged') this.sendCancel(requestId);
    this.endRequest(requestId, 'failed', 'You said the codes didn’t match, so the device was not added.');
    if (this.answering === requestId) this.answering = null;
    this.publish();
  }

  // --- Both -------------------------------------------------------------------------------

  /**
   * Stops whatever join this device is part of and clears the join screen state. A stuck join is
   * forgotten here; its keys were retired when it got stuck, so the next request has new ones.
   */
  cancel(): void {
    if (this.mine) {
      if (isLive(this.mine.step)) this.sendCancel(this.mine.requestId);
      this.clearTimer(this.mine.requestId);
      this.mine = null;
    }
    if (this.answering) {
      const join = this.requests.get(this.answering);
      if (join && isLive(join.step) && join.step !== 'offered') this.sendCancel(join.requestId);
      this.requests.delete(this.answering);
      this.clearTimer(this.answering);
      this.answering = null;
    }
    this.publish();
  }

  private onCancelled({ requestId, reason }: Events['vault.join.cancelled']): void {
    const step = reason === 'expired' ? 'expired' : 'failed';
    if (this.mine?.requestId === requestId && nextNewDeviceStep(this.mine.step, step === 'expired' ? 'expired' : 'cancelled')) {
      Object.assign(this.mine, { step, error: joinEndedSentence(reason) });
      this.clearTimer(requestId);
      this.publish();
      return;
    }
    // Another of this person's devices answering is not an attempt that stopped.
    if (this.requests.has(requestId)) this.endRequest(requestId, step, joinEndedSentence(reason), reason !== 'taken');
  }

  /** Routes the computer's vault.join.* events. */
  handleEvent(event: string, data: unknown): void {
    switch (event) {
      case 'vault.join.requested':
        this.onRequested(data as Events['vault.join.requested']);
        break;
      case 'vault.join.challenged':
        void this.onChallenged(data as Events['vault.join.challenged']);
        break;
      case 'vault.join.revealed':
        void this.onRevealed(data as Events['vault.join.revealed']);
        break;
      case 'vault.join.finished':
        void this.onFinished(data as Events['vault.join.finished']);
        break;
      case 'vault.join.cancelled':
        this.onCancelled(data as Events['vault.join.cancelled']);
        break;
    }
  }

  /** Drops every request and nonce (the engine stopped). */
  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.mine = null;
    this.requests.clear();
    this.answering = null;
    this.stopped.clear();
  }

  /**
   * Ends a request this device saw: gone from `incoming`; still shown as `join` when it was the
   * one being answered. `stopped` counts it as an attempt that didn't get in.
   */
  private endRequest(requestId: string, step: ApproverStep, error?: string, stopped = step !== 'done'): void {
    const join = this.requests.get(requestId);
    this.clearTimer(requestId);
    if (!join) return;
    if (stopped) this.stopped.set(requestId, this.host.now());
    if (this.answering === requestId) Object.assign(join, { step, error });
    else this.requests.delete(requestId);
    this.publish();
  }

  private expireAt(requestId: string, expiresAt: number): void {
    this.clearTimer(requestId);
    const timer = setTimeout(
      () => {
        this.timers.delete(requestId);
        if (this.mine?.requestId === requestId && isLive(this.mine.step)) {
          Object.assign(this.mine, { step: 'expired', error: joinEndedSentence('expired') });
          this.publish();
        } else if (this.requests.has(requestId)) this.endRequest(requestId, 'expired', joinEndedSentence('expired'));
      },
      Math.max(0, expiresAt - this.host.now()),
    );
    this.timers.set(requestId, timer);
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }

  private sendCancel(requestId: string): void {
    void this.host.request('vault.join.cancel', { requestId }).catch(() => undefined);
  }

  private publish(): void {
    const now = this.host.now();
    const incoming: JoinRequestView[] = [...this.requests.values()]
      .filter((r) => isLive(r.step) && r.expiresAt > now && (r.requestId === this.answering || r.step === 'offered'))
      .map((r) => ({ id: r.requestId, deviceName: r.request.name, keyWords: wordsOf(r.request.ed), code: r.code, expiresAt: r.expiresAt }));
    this.host.publish({ join: this.joinView(), incoming });
  }

  private joinView(): JoinState | null {
    if (this.mine) {
      const { requestId, step, code, expiresAt, error, challenge, stuck } = this.mine;
      return {
        role: 'new',
        requestId,
        peerName: challenge?.name ?? null,
        ...(challenge ? { peerKeyWords: wordsOf(challenge.ed), vaultName: challenge.vaultName } : {}),
        code,
        stage: stageFor(step),
        expiresAt,
        ...(error ? { error } : {}),
        ...(stuck ? { stuck } : {}),
      };
    }
    const answered = this.answering ? this.requests.get(this.answering) : undefined;
    if (!answered) return null;
    const { requestId, step, code, expiresAt, error, request } = answered;
    return {
      role: 'approver',
      requestId,
      peerName: request.name,
      peerKeyWords: wordsOf(request.ed),
      code,
      stage: stageFor(step),
      expiresAt,
      ...(error ? { error } : {}),
    };
  }
}
