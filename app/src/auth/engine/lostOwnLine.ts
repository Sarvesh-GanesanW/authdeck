/**
 * Whether this device has lost a line of its own for good, and what to tell the person. Pure: the
 * engine passes its stored own head (secure storage) and the verified hashes of its own log in
 * the local copy and in the folder.
 *
 * The own head is raised before a line is sent, so it says this device signed every seq up to it.
 * A seq is never signed twice: two entries at one seq prove the identity signed two histories,
 * and every device then cuts it off. The local copy can lose a line the own head counts, since
 * expo-file-system has no fsync (localFiles.ts): a power loss can drop file data that secure
 * storage already holds the head for. While the folder still has the line, a read brings it
 * back. When neither has it, the line is gone, and waiting never helps: the device must not sign
 * at that seq again, so it can't write under this identity at all. It needs new keys and to join
 * again, through an approval from another device or the recovery phrase.
 */
import type { OwnHead } from './sync';

export type OwnLineStatus =
  /** This device holds every line it signed; it may sign the next one. */
  | { kind: 'held' }
  /** The folder holds the missing lines, or hasn't been read yet: a sync brings them back. */
  | { kind: 'read-back'; message: string }
  /** Neither the folder nor the local copy holds a line this device signed; it must join again. */
  | { kind: 'lost'; seq: number; folderHadIt: boolean; message: string };

export interface OwnLineInput {
  /** The highest own entry this device signed to send, from secure storage. */
  ownHead: OwnHead | null;
  /** Verified hashes of this device's own log in the local copy (VaultState.chains). */
  localChain: readonly string[];
  /** The same in the folder as last read, or null when it hasn't been read since the app started. */
  folderChain: readonly string[] | null;
  /** The head of this device's log the folder was last seen to hold (remembered heads), if any. */
  folderHead: OwnHead | null;
}

export const OWN_LINES_READ_BACK =
  "This device's copy of the vault is missing changes it already sent. Connect to the computer so AuthDeck can read them back, then try again.";

const LOST_START =
  'This device signed a vault change that neither it nor the computer kept, so AuthDeck cannot make changes from this device any more. It will not sign that change again: two different changes in one place would make this device look copied, and the other devices would cut it off.';
const FOLDER_LOST = ' The computer had this change once, so its vault folder lost it: if you can restore the folder from a backup, do that and sync first.';
const DEVICE_LOST = ' This device likely lost it when it shut down while saving.';
const LOST_STEPS = ' To keep using the vault here, delete the vault from this device, then restore it with your recovery phrase.';

const holds = (chain: readonly string[] | null, head: OwnHead) => chain !== null && chain[head.seq] === head.hash;

/** Where this device's own lines stand against its stored own head. */
export function ownLineStatus({ ownHead, localChain, folderChain, folderHead }: OwnLineInput): OwnLineStatus {
  if (!ownHead || holds(localChain, ownHead)) return { kind: 'held' };
  // A different line of its own at that seq: a read never replaces a local verified line, so nothing brings the signed one back.
  const localDiffers = localChain.length > ownHead.seq;
  if (!localDiffers && (folderChain === null || holds(folderChain, ownHead))) return { kind: 'read-back', message: OWN_LINES_READ_BACK };
  const folderHadIt = folderHead !== null && folderHead.seq >= ownHead.seq;
  return { kind: 'lost', seq: ownHead.seq, folderHadIt, message: LOST_START + (folderHadIt ? FOLDER_LOST : DEVICE_LOST) + LOST_STEPS };
}
