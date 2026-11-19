/**
 * Header changes, all signed by the owner's device. Each adds 1 to `rev`. A take-over and a new
 * recovery identity also add a change to the set's authority (authority.ts): the take-over's
 * signed by the recovery identity, the other by the owner. Removing
 * anyone, replacing the recovery identity, settling two headers and taking the set over also make
 * a new data key (`epoch` + 1): every line is signed again by the owner under it, keeping its
 * name and version, and every live value is boxed again. Deletions (tombstones) are kept, so no
 * device that saw one can be shown an older value of that name, and a name added again continues
 * from the deleted version. They count against ENV_LIMITS.names like any line.
 */
import { fromBase64Url, takeRandom, toBase64Url, type RandomBytes } from '../vault/bytes';
import { deviceIdFor, isUsableEd25519Key, isUsableSealingKey, type DeviceKeys } from '../vault/crypto';
import { envAuthorityExtends, envAuthorityHolders, signEnvAuthorityChange } from './authority';
import { EnvFileRefused } from './errors';
import {
  ENV_DATA_KEY_BYTES,
  envMemberRecord,
  envRecoveryRecord,
  envWrap,
  openEnvDataKey,
  openEnvValue,
  publicHalf,
  sealEnvValue,
  wrapMatches,
  type EnvNewMember,
} from './keys';
import { mergeValueLines } from './merge';
import { signEnvHeader, signEnvValueLine } from './signing';
import { ENV_FORMAT, ENV_LIMITS, type EnvAuthority, type EnvHeader, type EnvMember, type EnvMemberId, type EnvPublicKeys, type EnvRecovery, type EnvSetFile, type EnvValueLine } from './types';

/** A change that made a new data key. */
export interface EnvRekeyResult {
  file: EnvSetFile;
  /** The new epoch's data key. */
  dataKey: Uint8Array;
  /**
   * Live variables someone who lost access could already read, in file order: rotate them at
   * their providers. Empty when nobody lost access (settling headers, fixing old-epoch lines).
   */
  rotate: string[];
}

/** The owner device, and the data keys it holds by epoch (the current one at least). */
export interface EnvOwnerContext {
  file: EnvSetFile;
  owner: DeviceKeys;
  /** Must hold the header's epoch; older epochs too when a line still uses one (`wrong-epoch`). */
  dataKeys: Readonly<Record<number, Uint8Array>>;
  time: number;
}

/**
 * Adds a device as a member (rev + 1, same epoch): wraps the current key to it, signs the header.
 * Throws a plain Error when `owner` isn't the header's owner, the device is already listed, or its
 * keys are unusable; EnvFileRefused `too-large` 'members' past ENV_LIMITS.members.
 */
export function addEnvMember(context: EnvOwnerContext & { member: EnvNewMember }): EnvSetFile {
  const { file, owner, time } = context;
  const { header } = file;
  const dataKey = currentKey(context);
  const { member } = context;
  if (!isUsableEd25519Key(member.edPublic) || !isUsableSealingKey(member.xPublic)) throw new Error("The new member's keys can't be used.");
  const id = deviceIdFor(member.edPublic);
  if (header.members.some((existing) => existing.id === id) || header.recovery?.id === id) throw new Error('That device is already in the set.');
  if (header.members.length >= ENV_LIMITS.members) throw new EnvFileRefused({ kind: 'too-large', limit: 'members' });
  const record = envMemberRecord(dataKey, { set: header.set, epoch: header.epoch }, member, 'member', time);
  const unsigned = nextHeader(header, { members: [...header.members, record], recovery: header.recovery, rev: header.rev + 1, epoch: header.epoch, time, signer: owner.deviceId });
  return { header: signEnvHeader(unsigned, owner), values: file.values };
}

/**
 * Removes a member and re-keys (rev + 1, epoch + 1). `rotate` lists every live variable, since the
 * removed device could read them all. Throws a plain Error when `owner` isn't the owner, the id
 * isn't a member, or it is the owner itself.
 */
export function removeEnvMember(context: EnvOwnerContext & { memberId: EnvMemberId; random: RandomBytes }): EnvRekeyResult {
  const { file, owner, memberId } = context;
  const target = file.header.members.find((member) => member.id === memberId);
  if (!target) throw new Error("That device isn't a member of the set.");
  if (target.role === 'owner') throw new Error("The owner can't remove itself; make another phone the owner with the recovery phrase instead.");
  currentKey(context);
  return rekey({
    ...context,
    previous: file.header,
    values: file.values,
    members: file.header.members.filter((member) => member.id !== memberId),
    recovery: file.header.recovery,
    headerSigner: owner,
    valueSigner: owner,
    rotate: true,
  });
}

/**
 * A new key with the same members (rev + 1, epoch + 1): what the owner does for a `wrong-epoch`
 * line, re-encrypting it under the current key. `rotate` is empty. Throws a plain Error when a
 * line's epoch has no key in `dataKeys`.
 */
export function rekeyEnvSet(context: EnvOwnerContext & { random: RandomBytes }): EnvRekeyResult {
  const { file, owner } = context;
  currentKey(context);
  return rekey({ ...context, previous: file.header, values: file.values, members: file.header.members, recovery: file.header.recovery, headerSigner: owner, valueSigner: owner, rotate: false });
}

/**
 * Settles a merge that stopped with `two-headers`: one header above both (rev = max + 1, epoch =
 * max + 1) under the longer of the two authorities, which must continue the other (a recovery
 * change on one side). The recovery identity is that authority's. Members: those in both, plus those either side added
 * since `base` (a removal on either side stands). Values: merged per name as mergeEnvFiles does,
 * then re-keyed (deletions kept). `rotate` lists every live variable when a member was dropped, else it is empty.
 * `context.file` is ours. Throws a plain Error when either side's header isn't signed by `owner`,
 * or when the two authorities went separate ways.
 */
export function settleEnvHeaders(context: EnvOwnerContext & { base: EnvSetFile | null; theirs: EnvSetFile; random: RandomBytes }): EnvRekeyResult {
  const { file: ours, theirs, base, owner } = context;
  if (ours.header.set !== theirs.header.set) throw new Error('The two files are different sets.');
  for (const side of [ours.header, theirs.header]) {
    const sideOwner = side.members.find((member) => member.role === 'owner');
    if (sideOwner?.id !== owner.deviceId) throw new Error('Only the owner of both member lists can settle them.');
  }
  const authority = settledAuthority(ours.header, theirs.header);
  currentKey(context);
  const baseIds = new Set(base?.header.members.map((member) => member.id) ?? []);
  const theirIds = new Set(theirs.header.members.map((member) => member.id));
  const ourIds = new Set(ours.header.members.map((member) => member.id));
  // In both lists, or added by one side since the base: a removal on either side stands.
  const keep = (id: string) => (ourIds.has(id) && theirIds.has(id)) || !baseIds.has(id);
  const members = [...ours.header.members, ...theirs.header.members.filter((member) => !ourIds.has(member.id))].filter((member) => keep(member.id));
  const memberIds = new Set(members.map((member) => member.id));
  const values = mergeValueLines(ours, theirs, { keptEpoch: 0, members: memberIds });
  const dropped = [...ourIds, ...theirIds].some((id) => !memberIds.has(id));
  return rekey({
    ...context,
    previous: ours.header,
    rev: Math.max(ours.header.rev, theirs.header.rev) + 1,
    epoch: Math.max(ours.header.epoch, theirs.header.epoch) + 1,
    values,
    members,
    authority,
    recovery: recoveryRecordOf(envAuthorityHolders(authority).recovery),
    headerSigner: owner,
    valueSigner: owner,
    rotate: dropped,
  });
}

/**
 * Adds or replaces the recovery identity (or clears it with null), with an authority change signed
 * by the owner, so a replaced phrase can no longer take the set over. Adding one where there was
 * none only wraps the current key (rev + 1). Replacing or clearing one re-keys, since the old
 * phrase could open the key; `rotate` then lists every live variable.
 */
export function setEnvRecovery(
  context: EnvOwnerContext & { recovery: Pick<DeviceKeys, 'edPublic' | 'xPublic' | 'deviceId'> | null; random: RandomBytes },
): EnvRekeyResult {
  const { file, owner, time, recovery } = context;
  const { header } = file;
  const dataKey = currentKey(context);
  if ((recovery?.deviceId ?? null) === (header.recovery?.id ?? null)) throw new Error('That is already the recovery identity of this set.');
  const replacement = recovery ? { ed: toBase64Url(recovery.edPublic), x: toBase64Url(recovery.xPublic) } : null;
  const ownerKeys = envAuthorityHolders(header.authority).owner;
  const authority = signEnvAuthorityChange(header.set, header.authority, { kind: 'recovery', owner: ownerKeys, recovery: replacement, time }, owner);
  if (!header.recovery) {
    const record = envRecoveryRecord(dataKey, { set: header.set, epoch: header.epoch }, recovery!);
    const unsigned = nextHeader(header, { authority, members: header.members, recovery: record, rev: header.rev + 1, epoch: header.epoch, time, signer: owner.deviceId });
    return { file: { header: signEnvHeader(unsigned, owner), values: file.values }, dataKey, rotate: [] };
  }
  return rekey({ ...context, previous: header, authority, values: file.values, members: header.members, recovery: recoveryRecordOf(replacement), headerSigner: owner, valueSigner: owner, rotate: true });
}

/** A take-over: the re-keyed set, and every device it dropped, so the new owner can ask them back. */
export interface EnvTakeOverResult extends EnvRekeyResult {
  /** The old owner device and every other member, as the file listed them, in file order. */
  removed: Pick<EnvMember, 'id' | 'label' | 'form' | 'role'>[];
}

/**
 * The recovery identity makes a new phone the owner. It signs a take-over certificate onto the
 * set's authority (authority epoch + 1), naming the new owner and keeping itself as the recovery
 * identity. The new header holds only that phone (and the recovery identity) under a new key
 * (rev + 1, epoch + 1): the member list came from a file the phone can't vouch for, so nobody in
 * it is given the new key. The owner adds people back after comparing them as usual; `removed`
 * lists them. The header and every line are signed by the new owner. `rotate` lists every live
 * variable. Throws a plain Error when `recovery` isn't the recovery identity the authority names.
 */
export function takeOverEnvSet(input: {
  file: EnvSetFile;
  recovery: DeviceKeys;
  newOwner: DeviceKeys;
  label: string;
  form: 'phone' | 'tablet' | null;
  time: number;
  random: RandomBytes;
}): EnvTakeOverResult {
  const { file, recovery, newOwner, time } = input;
  const { header } = file;
  if (header.recovery?.id !== recovery.deviceId || header.recovery.ed !== toBase64Url(recovery.edPublic)) {
    throw new Error("That recovery phrase isn't this set's: check the 12 words, or ask the owner to add you.");
  }
  const dataKey = openEnvDataKey(header, recovery);
  const oldOwner = header.members.find((member) => member.role === 'owner')!;
  if (oldOwner.id === newOwner.deviceId) throw new Error('This device is already the owner.');
  const authority = signEnvAuthorityChange(header.set, header.authority, { kind: 'takeover', owner: { ed: toBase64Url(newOwner.edPublic), x: toBase64Url(newOwner.xPublic) }, recovery: header.recovery, time }, recovery);
  const ownerRecord = envMemberRecord(dataKey, { set: header.set, epoch: header.epoch }, { ...publicHalf(newOwner), label: input.label, form: input.form }, 'owner', time);
  const removed = header.members.filter((member) => member.id !== newOwner.deviceId).map(({ id, label, form, role }) => ({ id, label, form, role }));
  const result = rekey({
    dataKeys: { [header.epoch]: dataKey },
    time,
    random: input.random,
    previous: header,
    authority,
    values: file.values,
    members: [ownerRecord],
    recovery: header.recovery,
    headerSigner: newOwner,
    valueSigner: newOwner,
    rotate: true,
  });
  return { ...result, removed };
}

/** The owner's key for the header's epoch, checked against the owner's own wrap. */
function currentKey(context: EnvOwnerContext): Uint8Array {
  const { header } = context.file;
  const owner = header.members.find((member) => member.role === 'owner')!;
  if (owner.id !== context.owner.deviceId || owner.ed !== toBase64Url(context.owner.edPublic)) throw new Error('Only the owner of the set can change who is in it.');
  const dataKey = context.dataKeys[header.epoch];
  if (!dataKey || !wrapMatches(dataKey, { set: header.set, epoch: header.epoch }, owner)) throw new Error("The keys given don't include this set's current key.");
  return dataKey;
}

/** The header after `previous`: the same set and name, under `authority` when it changed. */
function nextHeader(
  previous: EnvHeader,
  next: { authority?: EnvAuthority; members: EnvMember[]; recovery: EnvRecovery | null; rev: number; epoch: number; time: number; signer: string },
): Omit<EnvHeader, 'sig'> {
  const { authority = previous.authority, ...rest } = next;
  return { format: ENV_FORMAT, set: previous.set, name: previous.name, authority, ...rest };
}

/** The longer of two authorities, when it continues the other. */
function settledAuthority(ours: EnvHeader, theirs: EnvHeader): EnvAuthority {
  if (envAuthorityExtends(theirs, ours)) return ours.authority;
  if (envAuthorityExtends(ours, theirs)) return theirs.authority;
  throw new Error("The two member lists name different recovery identities that can't be settled: keep the newer file and set the recovery phrase again.");
}

/** A recovery record before its wrap is made. */
function recoveryRecordOf(keys: EnvPublicKeys | null): { id: string; ed: string; x: string } | null {
  return keys ? { id: deviceIdFor(fromBase64Url(keys.ed)), ed: keys.ed, x: keys.x } : null;
}

interface RekeyPlan {
  previous: EnvHeader;
  /** The new header's authority, when this change adds to it. */
  authority?: EnvAuthority;
  rev?: number;
  epoch?: number;
  values: readonly EnvValueLine[];
  members: readonly EnvMember[];
  recovery: { id: string; ed: string; x: string } | null;
  headerSigner: DeviceKeys;
  valueSigner: DeviceKeys;
  dataKeys: Readonly<Record<number, Uint8Array>>;
  time: number;
  random: RandomBytes;
  /** Whether someone lost access, so every live variable must be rotated. */
  rotate: boolean;
}

/**
 * A new data key: every holder's wrap redone, every live value opened with its epoch's key and
 * boxed again under the new one, and every line, tombstones included, signed again by
 * `valueSigner` under the new epoch at the same name and version.
 */
function rekey(plan: RekeyPlan): EnvRekeyResult {
  const { previous, time, random } = plan;
  const scope = { set: previous.set, epoch: plan.epoch ?? previous.epoch + 1 };
  const dataKey = takeRandom(random, ENV_DATA_KEY_BYTES);
  const members = plan.members.map((member) => ({ ...member, key: envWrap(dataKey, scope, member) }));
  const recovery = plan.recovery ? { ...plan.recovery, key: envWrap(dataKey, scope, plan.recovery) } : null;
  const values: EnvValueLine[] = [];
  for (const line of plan.values) {
    const box = line.box ? sealEnvValue(dataKey, { ...scope, name: line.name, version: line.version }, openWithEpochKey(plan, line), random) : null;
    // Later than the line it replaces, so a merge with that line keeps this one.
    const lineTime = Math.max(time, line.time + 1);
    values.push(signEnvValueLine({ name: line.name, version: line.version, author: plan.valueSigner.deviceId, time: lineTime, box }, scope, plan.valueSigner));
  }
  const unsigned = nextHeader(previous, { authority: plan.authority, members, recovery, rev: plan.rev ?? previous.rev + 1, epoch: scope.epoch, time, signer: plan.headerSigner.deviceId });
  const file = { header: signEnvHeader(unsigned, plan.headerSigner), values };
  const rotate = plan.rotate ? plan.values.filter((line) => line.box !== null).map((line) => line.name) : [];
  return { file, dataKey, rotate };
}

function openWithEpochKey(plan: RekeyPlan, line: EnvValueLine): string {
  const epoch = line.box!.epoch;
  const key = plan.dataKeys[epoch];
  if (!key) throw new Error(`${line.name} is under key ${epoch}, which this device doesn't hold.`);
  return openEnvValue(key, plan.previous.set, line)!;
}
