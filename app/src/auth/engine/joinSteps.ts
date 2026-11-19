/**
 * The order of a device approval, on both sides. The check code is only safe when each side
 * moves strictly forward: the approver sends its nonce only once the new device's commitment has
 * arrived (it comes in the request), and the new device reveals its nonce only once the
 * approver's challenge has arrived. A message that arrives out of turn is ignored. Pure.
 */
import type { JoinState } from '../contract';

/** New device: asked → revealed its nonce (after the challenge) → let in. */
export type NewDeviceStep = 'asked' | 'revealed' | 'done' | 'failed' | 'expired';
export type NewDeviceEvent = 'challenged' | 'finished' | 'refused' | 'cancelled' | 'expired';

/** Approver: saw the request (with its commitment) → sent its challenge → got the reveal → wrote device.add. */
export type ApproverStep = 'offered' | 'challenged' | 'revealed' | 'done' | 'failed' | 'expired';
export type ApproverEvent = 'accept' | 'revealed' | 'approve' | 'deny' | 'cancelled' | 'expired';

const NEW_DEVICE: Record<NewDeviceStep, Partial<Record<NewDeviceEvent, NewDeviceStep>>> = {
  asked: { challenged: 'revealed', cancelled: 'failed', expired: 'expired' },
  revealed: { finished: 'done', refused: 'failed', cancelled: 'failed', expired: 'expired' },
  done: {},
  failed: {},
  expired: {},
};

const APPROVER: Record<ApproverStep, Partial<Record<ApproverEvent, ApproverStep>>> = {
  offered: { accept: 'challenged', deny: 'failed', cancelled: 'failed', expired: 'expired' },
  challenged: { revealed: 'revealed', deny: 'failed', cancelled: 'failed', expired: 'expired' },
  revealed: { approve: 'done', deny: 'failed', cancelled: 'failed', expired: 'expired' },
  done: {},
  failed: {},
  expired: {},
};

/** The step after `event`, or null when the event is out of turn and must be ignored. */
export function nextNewDeviceStep(step: NewDeviceStep, event: NewDeviceEvent): NewDeviceStep | null {
  return NEW_DEVICE[step][event] ?? null;
}

export function nextApproverStep(step: ApproverStep, event: ApproverEvent): ApproverStep | null {
  return APPROVER[step][event] ?? null;
}

const STAGES: Record<NewDeviceStep | ApproverStep, JoinState['stage']> = {
  asked: 'waiting',
  offered: 'waiting',
  challenged: 'waiting',
  revealed: 'compare',
  done: 'done',
  failed: 'failed',
  expired: 'expired',
};

/** What the join screen shows for a step. */
export function stageFor(step: NewDeviceStep | ApproverStep): JoinState['stage'] {
  return STAGES[step];
}

/** Still in progress: not finished, failed or expired. */
export function isLive(step: NewDeviceStep | ApproverStep): boolean {
  return step !== 'done' && step !== 'failed' && step !== 'expired';
}
