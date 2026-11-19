/**
 * Own-device joins of an env set, both sides, over the computer's env.join.* relay: the vault's
 * check-code approval (vault/approval.ts) with the code under the env domain (envcore join.ts).
 * The relay is untrusted; the step order (../engine/joinSteps) and the code keep it honest, and
 * the new device then checks the set file itself (checkEnvJoined). Nonces live only in memory.
 */
import type { EnvJoinRequestView, EnvJoinState } from '../envContract';
import { envApproverCheckCode, envNewDeviceCheckCode, type EnvNewMember } from '../../envcore';
import type { EnvEvents, VaultJoinRequest } from '../../protocol';
import { createJoinChallenge, createJoinRequest, createJoinReveal, readJoinRequest, type JoinChallenge, type JoinRequest } from '../../vault/approval';
import type { RandomBytes } from '../../vault/bytes';
import type { DeviceKeys } from '../../vault/crypto';
import { isLive, nextApproverStep, nextNewDeviceStep, stageFor, type ApproverStep, type NewDeviceStep } from '../engine/joinSteps';
import { joinEndedSentence } from '../engine/sentences';
import type { EnvLink } from './host';
import { JOIN_REQUEST_GONE } from './words';

export interface OwnJoinHost {
  random: RandomBytes;
  now(): number;
  link: EnvLink;
  /** This device's env identity; throws when the vault is locked. */
  identity(): DeviceKeys;
  /** How this device is named to the other one: the member label it will have. */
  deviceLabel(): string;
  /** Approver: the set's name when this device owns it and may answer, else null. */
  ownedSetName(setId: string): string | null;
  /** Approver: adds the device to the set and has the agent write it. */
  addMember(setId: string, member: EnvNewMember): Promise<void>;
  /** New device: reads the set, checks it lists this device as the challenge's owner added it, and keeps it. */
  adoptJoined(setId: string, device: DeviceKeys, challenge: JoinChallenge): Promise<void>;
  changed(): void;
}

interface NewDeviceJoin {
  setId: string;
  setName: string;
  requestId: string;
  step: NewDeviceStep;
  device: DeviceKeys;
  request: JoinRequest;
  nonce: Uint8Array;
  challenge: JoinChallenge | null;
  code: string | null;
  expiresAt: number;
  error?: string;
}

interface ApproverJoin {
  setId: string;
  setName: string;
  requestId: string;
  step: ApproverStep;
  request: VaultJoinRequest;
  challenge: JoinChallenge | null;
  code: string | null;
  expiresAt: number;
}

export class OwnJoins {
  private mine: NewDeviceJoin | null = null;
  private offers = new Map<string, ApproverJoin>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly host: OwnJoinHost) {}

  // --- New device ---------------------------------------------------------------------------

  async requestJoin(setId: string, setName: string): Promise<void> {
    this.cancel();
    const device = this.host.identity();
    const { request, nonce } = createJoinRequest(device, this.host.deviceLabel(), this.host.random);
    const { requestId, expiresAt } = await this.host.link.request('env.join.request', { setId, request });
    this.mine = { setId, setName, requestId, step: 'asked', device, request, nonce, challenge: null, code: null, expiresAt };
    this.expireAt(expiresAt);
    this.host.changed();
  }

  private async onChallenged({ requestId, challenge }: EnvEvents['env.join.challenged']): Promise<void> {
    const join = this.mine;
    if (!join || join.requestId !== requestId) return;
    const next = nextNewDeviceStep(join.step, 'challenged');
    if (!next) return;
    let code: string;
    try {
      if (challenge.vault !== join.setId) throw new Error('another set');
      code = envNewDeviceCheckCode(join.request, join.nonce, challenge);
    } catch {
      this.failMine('The other device sent a damaged answer. Start again.', true);
      return;
    }
    Object.assign(join, { step: next, challenge, code });
    this.host.changed();
    try {
      await this.host.link.request('env.join.reveal', { requestId, reveal: createJoinReveal(join.nonce) });
    } catch (err) {
      this.failMine((err as Error).message, false);
    }
  }

  private async onFinished({ requestId, approved }: EnvEvents['env.join.finished']): Promise<void> {
    const join = this.mine;
    if (!join || join.requestId !== requestId) return;
    if (!approved) {
      if (nextNewDeviceStep(join.step, 'refused')) this.failMine("The other device said the codes didn't match, so this device wasn't added.", false);
      return;
    }
    const next = nextNewDeviceStep(join.step, 'finished');
    if (!next || !join.challenge) return;
    try {
      await this.host.adoptJoined(join.setId, join.device, join.challenge);
      join.step = next;
      this.host.changed();
    } catch (err) {
      this.failMine((err as Error).message, false);
    }
  }

  private failMine(error: string, tellRelay: boolean): void {
    const join = this.mine;
    if (!join) return;
    if (tellRelay) this.sendCancel(join.requestId);
    Object.assign(join, { step: 'failed', error });
    this.host.changed();
  }

  // --- Owner (approver) ---------------------------------------------------------------------

  private onRequested({ requestId, setId, request, expiresAt }: EnvEvents['env.join.requested']): void {
    const setName = this.host.ownedSetName(setId);
    if (setName === null || expiresAt <= this.host.now()) return;
    try {
      readJoinRequest(request);
    } catch {
      return;
    }
    this.offers.set(requestId, { setId, setName, requestId, step: 'offered', request, challenge: null, code: null, expiresAt });
    this.expireAt(expiresAt);
    this.host.changed();
  }

  hasOffer(requestId: string): boolean {
    return this.offers.has(requestId);
  }

  async accept(requestId: string): Promise<void> {
    const join = this.offers.get(requestId);
    const next = join && nextApproverStep(join.step, 'accept');
    if (!join || !next) throw new Error(JOIN_REQUEST_GONE);
    const device = this.host.identity();
    const { challenge } = createJoinChallenge(device, { vaultId: join.setId, vaultName: join.setName, deviceName: this.host.deviceLabel() }, this.host.random);
    Object.assign(join, { step: next, challenge });
    this.host.changed();
    try {
      await this.host.link.request('env.join.challenge', { requestId, challenge });
    } catch (err) {
      this.offers.delete(requestId);
      this.host.changed();
      throw err;
    }
  }

  private onRevealed({ requestId, reveal }: EnvEvents['env.join.revealed']): void {
    const join = this.offers.get(requestId);
    const next = join && nextApproverStep(join.step, 'revealed');
    if (!join || !next || !join.challenge) return;
    try {
      join.code = envApproverCheckCode(join.request, join.challenge, reveal);
      join.step = next;
    } catch {
      this.sendCancel(requestId);
      this.offers.delete(requestId);
    }
    this.host.changed();
  }

  /** Owner: the codes matched; adds the device, then tells it. */
  async approve(requestId: string): Promise<void> {
    const join = this.offers.get(requestId);
    if (!join) throw new Error(JOIN_REQUEST_GONE);
    const next = nextApproverStep(join.step, 'approve');
    if (!next || !join.code) throw new Error('Wait until both devices show the code, then approve.');
    const keys = readJoinRequest(join.request);
    await this.host.addMember(join.setId, { edPublic: keys.edPublic, xPublic: keys.xPublic, label: join.request.name, form: null });
    await this.host.link.request('env.join.finish', { requestId, approved: true });
    this.offers.delete(requestId);
    this.host.changed();
  }

  /** Owner: the codes didn't match, or the person declined before answering. */
  async decline(requestId: string): Promise<void> {
    const join = this.offers.get(requestId);
    if (!join) throw new Error(JOIN_REQUEST_GONE);
    this.offers.delete(requestId);
    this.host.changed();
    if (join.step === 'revealed') await this.host.link.request('env.join.finish', { requestId, approved: false }).catch(() => undefined);
    else if (join.step === 'challenged') this.sendCancel(requestId);
  }

  // --- Both ---------------------------------------------------------------------------------

  /** Stops this device's own join, or clears one that finished (done, failed or expired). */
  cancel(): void {
    const join = this.mine;
    if (!join) return;
    if (isLive(join.step)) this.sendCancel(join.requestId);
    this.mine = null;
    this.host.changed();
  }

  private onCancelled({ requestId, reason }: EnvEvents['env.join.cancelled']): void {
    if (this.mine?.requestId === requestId) {
      const step = reason === 'expired' ? 'expired' : 'failed';
      if (nextNewDeviceStep(this.mine.step, reason === 'expired' ? 'expired' : 'cancelled')) {
        Object.assign(this.mine, { step, error: joinEndedSentence(reason) });
        this.host.changed();
      }
      return;
    }
    if (this.offers.delete(requestId)) this.host.changed();
  }

  handleEvent<E extends keyof EnvEvents>(event: E, data: EnvEvents[E]): void {
    switch (event) {
      case 'env.join.requested':
        this.onRequested(data as EnvEvents['env.join.requested']);
        break;
      case 'env.join.challenged':
        void this.onChallenged(data as EnvEvents['env.join.challenged']);
        break;
      case 'env.join.revealed':
        this.onRevealed(data as EnvEvents['env.join.revealed']);
        break;
      case 'env.join.finished':
        void this.onFinished(data as EnvEvents['env.join.finished']);
        break;
      case 'env.join.cancelled':
        this.onCancelled(data as EnvEvents['env.join.cancelled']);
        break;
    }
  }

  private expireAt(expiresAt: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.expire();
    }, Math.max(0, expiresAt - this.host.now()));
    this.timers.add(timer);
  }

  /** Drops expired steps; the relay also says so, but a phone that slept may have missed it. */
  expire(): void {
    const now = this.host.now();
    let changed = false;
    for (const [id, offer] of this.offers) {
      if (offer.expiresAt <= now) {
        this.offers.delete(id);
        changed = true;
      }
    }
    if (this.mine && isLive(this.mine.step) && this.mine.expiresAt <= now) {
      Object.assign(this.mine, { step: 'expired', error: joinEndedSentence('expired') });
      changed = true;
    }
    if (changed) this.host.changed();
  }

  private sendCancel(requestId: string): void {
    void this.host.link.request('env.join.cancel', { requestId }).catch(() => undefined);
  }

  /** Forgets every join and nonce (the vault locked, or the computer went away). */
  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.mine = null;
    this.offers.clear();
  }

  joinView(): EnvJoinState | null {
    const join = this.mine;
    if (!join) return null;
    return {
      setId: join.setId,
      setName: join.setName,
      peerName: join.challenge?.name ?? null,
      code: join.code,
      stage: stageFor(join.step),
      expiresAt: join.expiresAt,
      ...(join.error ? { error: join.error } : {}),
    };
  }

  requestViews(needsUnlock: boolean): EnvJoinRequestView[] {
    return [...this.offers.values()].map((offer) => ({
      id: offer.requestId,
      via: 'own-device',
      setId: offer.setId,
      setName: offer.setName,
      label: offer.request.name,
      form: null,
      keyWords: null,
      ownerKeyWords: null,
      commit: null,
      code: offer.code,
      expiresAt: offer.expiresAt,
      needsUnlock,
    }));
  }

  /** The own-device offers waiting on one set, for its join request count. */
  countFor(setId: string): number {
    return [...this.offers.values()].filter((offer) => offer.setId === setId).length;
  }
}
