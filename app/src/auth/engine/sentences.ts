/**
 * Plain sentences for what the vault core reports in terse, technical terms: why a change was
 * rejected or is waiting, a rolled-back folder, a join that ended. Pure.
 */
import type { RollbackProblem } from '../../vault/rollback';
import { sentence } from './accounts';

const NOT_INTRODUCED = 'no applied entry introduces this device';

/** Core reasons, matched by fragment, and what to tell the person instead. First match wins. */
const REASONS: [fragment: string, plain: string][] = [
  [NOT_INTRODUCED, 'None of your devices signed it, so it was ignored and nothing changed.'],
  ['the signature is not valid', "Its signature doesn't match the device it claims to come from, so it was ignored."],
  ['prev does not match', "It doesn't follow on from that device's earlier changes, so it was ignored."],
  ['entries are missing or out of order', "Some of that device's changes are missing from the vault folder, so the ones after the gap were ignored."],
  ['not valid JSON', 'The line in the vault folder is damaged, so it was ignored.'],
  ['the entry is malformed', 'The change is damaged or written by an incompatible version, so it was ignored.'],
  ['malformed body', 'The change is damaged or written by an incompatible version, so it was ignored.'],
  ['belongs to another vault', 'It belongs to a different vault, so it was ignored.'],
  ["in another device's file", "It was in another device's file, so it was ignored."],
  ['the author was removed', 'The device that made it had already been removed from the vault.'],
  ['recovery phrase was replaced before this entry', 'It was made with a recovery phrase that had already been replaced.'],
  [
    'made at the same time as another change',
    "Another device changed the vault's devices at the same time, and that change took precedence. Make this change again.",
  ],
  ['took its author out of the vault', 'Another device removed the device that made it at the same time, so it was ignored.'],
  [
    'took out a device this change would let in',
    'Another device removed a device at the same time that this change would have let in, so it was ignored. It is made again without that device.',
  ],
  ['made at the same time as another key change', 'Another device changed the vault key at the same time, and that change counts instead.'],
  ['the recovery phrase that made it was replaced at the same time', 'The recovery phrase that made it was replaced at the same time, so it was ignored.'],
  [
    'approved at the same time with other keys or another role',
    'The same device was approved twice at the same time with different keys or roles, so this one was ignored.',
  ],
  [
    'at the same time as a key change',
    'It was made with the old vault key while another device changed the key, so a removed device might have read it. It is made again under the new key.',
  ],
  [
    'a change made at the same time replaced',
    'It was made with a vault key another change replaced at the same time. It is made again under the key that counts.',
  ],
  ["which the vault's key never reached", 'It was made with a vault key the vault never used, so it was ignored.'],
  ['but the vault is at epoch', 'It was made with an old vault key after the key changed, so it was ignored.'],
  ['signed two different entries at seq', 'The device that made it signed two different versions of its history, so nothing it signed from there counts.'],
  [
    'signed two different histories; it must make new keys',
    'That device signed two different versions of its history. It has to make new keys before it can join again.',
  ],
  ['written before its device was added', 'It was made before its device was added to the vault, so it was ignored.'],
  ['not an active device of this vault', "That device isn't in the vault any more."],
  ['keeps its role', 'A device approved again keeps the role it had, so this was ignored.'],
  ['not sealed to every device staying', "The new vault key wasn't given to every device staying in the vault, so it was ignored."],
  ['sealed to a device that is not staying', 'The new vault key was given to a device that is not in the vault, so it was ignored.'],
  [
    "with a hash the folder doesn't have",
    "It names a version of another device's history that the vault folder doesn't have, so one of the two devices signed two different histories.",
  ],
  ['its time is earlier than an entry it says it had seen', 'Its time is earlier than a change it says it had already seen, so it was ignored.'],
  ['must keep its keys', 'A device approved again must keep the keys it had, so it was ignored.'],
  ["can't remove itself", "A device can't remove itself. Remove it from another device."],
  ['sealed to the recovery key too', 'The new vault key was not given to the recovery phrase, so it was ignored.'],
  ['that recovery phrase was replaced before', 'That recovery phrase was replaced earlier. Make a new one.'],
  ['the founder key and salt do not give this vault id', 'Only the device that created the vault can start it, so it was ignored.'],
  ["must be the founder's", 'Only the device that created the vault can start it, so it was ignored.'],
  ["device.hello must be the device's", 'A new device must first say hello, so this was ignored.'],
  ['the recovery identity can', 'The recovery phrase can only approve new devices, so this was ignored.'],
  ['not a device of this vault', "The device that made it wasn't in the vault at that point."],
  ['only an admin device can do this', 'Only an admin device can make that change.'],
  ['the account is encrypted under epoch', 'It was made with an old vault key after a device was removed, so it was ignored. Make the change again.'],
  ['the account could not be read', "It couldn't be decrypted with the vault key, so it was ignored."],
  ['there is no such account', 'The account had already been deleted.'],
  ['already in the vault', 'That device was already in the vault.'],
  ['that device was removed', 'That device was removed earlier. It has to make new keys before it can join again.'],
  ["the last device can't be removed", "The vault's last device can't be removed."],
  ["the last admin can't be removed", "A team vault's last admin can't be removed."],
  ['the vault was already created', 'The vault had already been created, so a second start was ignored.'],
  ['the vault was not created yet', 'It came before the vault was created, so it was ignored.'],
  ['is sealed for epoch', 'It was made with an old vault key after a device was removed, so it was ignored.'],
  ['every device in a personal vault is an admin', 'Every device in a personal vault must be an admin.'],
  ['it names an entry that is not in the folder yet', "It depends on a change that hasn't reached the vault folder yet. It applies once that device syncs."],
  ['it follows an entry that is still waiting', 'It follows a change that is still waiting. It applies once that change does.'],
];

/** A core rejection or waiting reason as a sentence a person can read. */
export function reasonSentence(coreReason: string): string {
  const match = REASONS.find(([fragment]) => coreReason.includes(fragment));
  return match ? match[1] : `It broke the vault's rules: ${sentence(coreReason)}`;
}

/** True when a chain rejection is a whole file no device vouches for (an "unsigned change"). */
export function isUnknownDeviceRejection(coreReason: string): boolean {
  return coreReason.includes(NOT_INTRODUCED);
}

/**
 * The rollback banner: which devices' history went back or changed in the folder. Every
 * problem is followed by a repair from this device's copy, so the sentence says so.
 */
export function rollbackSentence(problems: RollbackProblem[], deviceName: (id: string) => string, computerName: string | null): string | null {
  if (problems.length === 0) return null;
  const where = computerName ? `The vault folder on ${computerName}` : 'The vault folder';
  if (problems.every((p) => p.found === null)) {
    return `${where} was missing or emptied. AuthDeck wrote it back from this device's verified copy.`;
  }
  const names = [...new Set(problems.map((p) => deviceName(p.deviceId)))];
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const changed = problems.some((p) => p.kind === 'changed');
  const what = changed ? `changes from ${who} were replaced with different ones` : `changes from ${who} went missing`;
  return `${where} went back in time: ${what}. AuthDeck kept its verified copy and wrote it back. If you didn't restore a backup of that folder, someone may have tampered with it.`;
}

/** Why a join request ended, for the new device or the approver. */
export function joinEndedSentence(reason: 'cancelled' | 'expired' | 'disconnected' | 'taken'): string {
  switch (reason) {
    case 'cancelled':
      return 'The other device cancelled the request.';
    case 'expired':
      return 'The request expired after five minutes. Start again.';
    case 'disconnected':
      return 'The other device disconnected from the computer. Start again with both devices connected.';
    case 'taken':
      return 'Another of your devices is answering this request.';
  }
}
