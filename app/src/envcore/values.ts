/**
 * Changing variables: an edit on the phone, or a push from the computer that the phone signs. A
 * changed or added name gets a new line at its version + 1 (1 when the file never had it), boxed
 * under the current key and signed by the member making the change; a removed name becomes a
 * tombstone at version + 1. Unchanged names keep their lines byte for byte.
 */
import type { RandomBytes } from '../vault/bytes';
import type { DeviceKeys } from '../vault/crypto';
import { EnvFileRefused } from './errors';
import { checkEnvPlainValues, writeEnvFile } from './format';
import { openEnvValue, sealEnvValue, wrapMatches } from './keys';
import { signEnvValueLine } from './signing';
import type { EnvPlainValue, EnvSetFile, EnvValueLine } from './types';

/** What a change does, by name, in the order the names were given. */
export interface EnvValueChanges {
  upsert: EnvPlainValue[];
  remove: string[];
}

/** A signed change: the new file, and the names by what happened to them (protocol answer `signed`). */
export interface EnvChangeResult {
  file: EnvSetFile;
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * What a push changes, from the set's current plain values (openEnvValues) and the pushed file's.
 * A name whose value is the same is left out; with `prune`, live names missing from `pushed` are
 * removed. Throws EnvFileRefused when `pushed` fails checkEnvPlainValues.
 */
export function planEnvPush(current: readonly EnvPlainValue[], pushed: readonly EnvPlainValue[], prune: boolean): EnvValueChanges {
  const problem = checkEnvPlainValues(pushed);
  if (problem) throw new EnvFileRefused(problem);
  const currentValues = new Map(current.map(({ name, value }) => [name, value]));
  const pushedNames = new Set(pushed.map(({ name }) => name));
  return {
    upsert: pushed.filter(({ name, value }) => currentValues.get(name) !== value),
    remove: prune ? current.filter(({ name }) => !pushedNames.has(name)).map(({ name }) => name) : [],
  };
}

/**
 * Applies a change as `author` (a member of the header). Checks the result's caps (EnvFileRefused
 * `too-large`, `bad-name`, `duplicate-name`); removing a name that isn't live is a plain Error, as
 * is an author who isn't a member or a `dataKey` that isn't the header epoch's.
 */
export function changeEnvValues(input: {
  file: EnvSetFile;
  author: DeviceKeys;
  dataKey: Uint8Array;
  changes: EnvValueChanges;
  time: number;
  random: RandomBytes;
}): EnvChangeResult {
  const { file, author, dataKey, changes, time, random } = input;
  const { header } = file;
  const member = header.members.find((candidate) => candidate.id === author.deviceId);
  if (!member) throw new Error('Only a member of the set can change its variables.');
  if (!wrapMatches(dataKey, { set: header.set, epoch: header.epoch }, member)) throw new Error("The key given isn't this set's current key.");
  const problem = checkEnvPlainValues(changes.upsert);
  if (problem) throw new EnvFileRefused(problem);
  const scope = { set: header.set, epoch: header.epoch };
  const lines = new Map(file.values.map((line) => [line.name, line]));
  const result: EnvChangeResult = { file, added: [], changed: [], removed: [] };
  const sign = (line: Omit<EnvValueLine, 'sig'>) => signEnvValueLine(line, scope, author);

  for (const name of changes.remove) {
    const existing = lines.get(name);
    if (!existing?.box) throw new Error(`${name} isn't a variable in this set, so it can't be removed.`);
    if (changes.upsert.some((value) => value.name === name)) throw new Error(`${name} is both set and removed in one change.`);
    lines.set(name, sign({ name, version: existing.version + 1, author: author.deviceId, time, box: null }));
    result.removed.push(name);
  }
  for (const { name, value } of changes.upsert) {
    const existing = lines.get(name);
    if (existing?.box && existing.box.epoch === header.epoch && openEnvValue(dataKey, header.set, existing) === value) continue;
    const version = (existing?.version ?? 0) + 1;
    const box = sealEnvValue(dataKey, { ...scope, name, version }, value, random);
    lines.set(name, sign({ name, version, author: author.deviceId, time, box }));
    (existing?.box ? result.changed : result.added).push(name);
  }
  // Map keeps first-insertion order: existing names stay where they were, new ones go last.
  result.file = { header, values: [...lines.values()] };
  writeEnvFile(result.file);
  return result;
}
