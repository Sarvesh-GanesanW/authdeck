/** The env engine's words: sentences it throws or shows, and how names and changes read. Pure. */
import type { EnvFileChange, EnvMember } from '../../envcore';

export const NOT_UNLOCKED = 'Unlock AuthDeck first: env set keys open with the vault.';
export const REQUEST_ENDED = 'That request already ended.';
export const UNKNOWN_SET = 'That set is no longer on this device.';
export const NOT_A_MEMBER = "This device isn't a member of that set.";
export const ONLY_OWNER = "Only the set's owner device can change who is in it.";
export const REMOVED_READ_ONLY = 'This device was removed from that set, so it can only show what it saw.';
export const KEPT_CHANGING = 'The set file kept changing on the computer while AuthDeck saved. Try again in a moment.';
export const PLAN_CHANGED = "The set changed on the computer since the sheet opened, so this change now does something else. Check the changes again, then approve.";
export const REVIEW_CHANGED = 'The values under the old key changed on the computer since you reviewed them. Review them again, then choose.';
export const JOIN_REQUEST_GONE = 'That request is no longer waiting.';
export const OWNER_WORDS_CHANGED = "The owner's words changed since this sheet opened. Compare the new words with the owner again.";
export const AGENT_TOO_OLD = 'The AuthDeck Agent on this computer is too old for env sets. Update it, then try again.';
export const WRONG_ANSWER = "That answer doesn't fit this request.";

export function offlineSentence(computerName: string): string {
  return `${computerName} can't be reached. Open AuthDeck Agent on it, then try again.`;
}

export function notThePhrase(setName: string): string {
  return `These words don't open ${setName}. If you set up a new vault on this phone instead of restoring it, restore your vault with this phrase first.`;
}

export function notOurOwner(setName: string): string {
  return `${setName}'s owner isn't a device of your vault, so your recovery phrase can't take it over.`;
}

export function historyTooLong(setName: string): string {
  return `The git history of ${setName} is too long for this device to check, so AuthDeck won't take the set from it. Make a new set (authdeck env init in a fresh folder) and move the values there.`;
}

export function noRecovery(setName: string): string {
  return `${setName} has no recovery phrase, so it can't get a new owner. Make a new set, and add its members again.`;
}

/** "Maya Rao · Pixel 8" -> "Maya": the first word of the person part. */
export function shortPerson(label: string): string {
  const person = label.split(' · ')[0] ?? label;
  return person.trim().split(/\s+/)[0] || label;
}

/** "github.com/acme/api" -> "acme/api"; a remote without a host part stays as it is. */
export function repoName(remote: string | null): string | null {
  if (!remote) return null;
  const parts = remote.replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.length >= 3 ? parts.slice(-2).join('/') : parts.join('/');
}

/** A run's command as one line: arguments with spaces or quotes are quoted. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
}

function names(list: readonly string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
}

function person(member: EnvMember): string {
  return member.label.split(' · ')[0] ?? member.label;
}

/** One commit's change in a sentence: "Changed STRIPE_WEBHOOK_SECRET", "Removed Lucía Ortiz and made a new key". */
export function changeSentence(change: EnvFileChange, isFirst: boolean): string {
  if (isFirst) return change.added.length > 0 ? `Made the set with ${names(change.added)}` : 'Made the set';
  const parts: string[] = [];
  if (change.membersAdded.length > 0) parts.push(`Added ${names(change.membersAdded.map(person))}`);
  if (change.membersRemoved.length > 0) parts.push(`Removed ${names(change.membersRemoved.map(person))}`);
  if (change.added.length > 0) parts.push(`${parts.length ? 'added' : 'Added'} ${names(change.added)}`);
  if (change.changed.length > 0) parts.push(`${parts.length ? 'changed' : 'Changed'} ${names(change.changed)}`);
  if (change.removed.length > 0) parts.push(`${parts.length ? 'deleted' : 'Deleted'} ${names(change.removed)}`);
  if (change.newKey) parts.push(parts.length ? 'made a new key' : 'Made a new key');
  if (parts.length === 0) return 'No change to the set';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
