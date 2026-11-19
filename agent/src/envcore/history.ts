/**
 * What one commit changed in a set, worked out from the file before and after, for the phone's
 * history ("Changed STRIPE_WEBHOOK_SECRET", "Added Priya Nair", "Removed Lucía Ortiz, new key").
 * Who did it comes from the signatures, never from git's author.
 */
import { envHeaderHash } from './signing';
import type { EnvMember, EnvMemberId, EnvSetFile } from './types';

export interface EnvFileChange {
  /** Names, in the after file's order. A name brought back after deletion counts as added. */
  added: string[];
  changed: string[];
  removed: string[];
  membersAdded: EnvMember[];
  membersRemoved: EnvMember[];
  /** The epoch went up. */
  newKey: boolean;
  /** Who signed the change: the header's signer when the header changed, then each new line's author, once each, in that order. */
  signers: EnvMemberId[];
}

/** Compares two files (both already verified; `before` null for the commit that made the set). Pure, never throws. */
export function diffEnvFiles(before: EnvSetFile | null, after: EnvSetFile): EnvFileChange {
  const beforeLines = new Map((before?.values ?? []).map((line) => [line.name, line]));
  const afterNames = new Set(after.values.map((line) => line.name));
  const change: EnvFileChange = { added: [], changed: [], removed: [], membersAdded: [], membersRemoved: [], newKey: false, signers: [] };
  const signers = new Set<EnvMemberId>();
  if (!before || envHeaderHash(before.header) !== envHeaderHash(after.header)) signers.add(after.header.signer);
  for (const line of after.values) {
    const previous = beforeLines.get(line.name);
    if (previous?.sig !== line.sig) signers.add(line.author);
    if (line.box && !previous?.box) change.added.push(line.name);
    else if (line.box && previous && previous.version !== line.version) change.changed.push(line.name);
    else if (!line.box && previous?.box) change.removed.push(line.name);
  }
  // A live name gone without a tombstone: AuthDeck keeps tombstones, so only a hand-made file does this.
  for (const [name, line] of beforeLines) {
    if (line.box && !afterNames.has(name)) change.removed.push(name);
  }
  const beforeIds = new Set(before?.header.members.map((member) => member.id) ?? []);
  const afterIds = new Set(after.header.members.map((member) => member.id));
  change.membersAdded = after.header.members.filter((member) => !beforeIds.has(member.id));
  change.membersRemoved = (before?.header.members ?? []).filter((member: EnvMember) => !afterIds.has(member.id));
  change.newKey = before !== null && after.header.epoch > before.header.epoch;
  change.signers = [...signers];
  return change;
}
