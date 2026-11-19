/** Shared steps for the env attack tests: files as the computer holds them, built outside the engine. */
import { addEnvMember, changeEnvValues, envRecoveryKeys, openEnvDataKey, sealEnvValue, signEnvHeader, signEnvValueLine, verifyEnvFile, writeEnvFile, type EnvSetFile } from '../../src/envcore';
import { envMemberRecord, envRecoveryRecord, publicHalf } from '../../src/envcore/keys';
import { ENV_FORMAT } from '../../src/envcore/types';
import type { DeviceKeys } from '../../src/vault/crypto';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import type { RandomBytes } from '../../src/vault/bytes';
import type { Rig } from '../env/fakes';

export function fileOf(text: string): EnvSetFile {
  const verified = verifyEnvFile(text, null);
  if (!verified.ok) throw new Error(`refused: ${verified.problem.kind}`);
  return verified.set.file;
}

/** Adds `member` to the set as the owner phone would, outside the engine (the file on the computer only). */
export function addedOnComputer(r: Rig, setId: string, member: DeviceKeys, label: string): string {
  const current = fileOf(r.agent.sets.get(setId)!.text);
  const file = addEnvMember({
    file: current,
    owner: r.device,
    dataKeys: { [current.header.epoch]: r.store.keys.get(setId)![current.header.epoch]! },
    time: r.clock.now,
    member: { edPublic: member.edPublic, xPublic: member.xPublic, label, form: 'phone' },
  });
  return writeEnvFile(file);
}

/** Adds `member` on the computer and lets the owner phone read it. */
export async function addMember(r: Rig, setId: string, member: DeviceKeys, label: string): Promise<void> {
  r.agent.put(setId, 'acme-api', addedOnComputer(r, setId, member, label));
  await r.engine.sync();
}

/** The value line for `name` in a file's text, as written. */
export function valueLineOf(text: string, name: string): string {
  const line = text.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`no line for ${name}`);
  return line;
}

/** The text with the line for `name` replaced by `line`, or `line` added at the end when there is none. */
export function withLine(text: string, name: string, line: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const index = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  return `${lines.join('\n')}\n`;
}

export function liveNames(text: string): string[] {
  return fileOf(text)
    .values.filter((line) => line.box !== null)
    .map((line) => line.name);
}

/** Lines a member signs under the set's current key in `text`, at `time` by its own clock. */
export function memberLines(text: string, member: DeviceKeys, upsert: { name: string; value: string }[], time: number, random: RandomBytes): string[] {
  const file = fileOf(text);
  const changed = changeEnvValues({ file, author: member, dataKey: openEnvDataKey(file.header, member), changes: { upsert, remove: [] }, time, random });
  const written = writeEnvFile(changed.file);
  return upsert.map(({ name }) => valueLineOf(written, name));
}

/** Gives the rig's vault a recovery phrase, as the vault engine would report it. */
export function phraseOn(r: Rig, random: RandomBytes): { phrase: string; keys: DeviceKeys } {
  const phrase = generateRecoveryPhrase(random);
  const keys = envRecoveryKeys(phrase, r.vault.vault!);
  r.vault.recoveryKeys = { deviceId: keys.deviceId, edPublic: keys.edPublic, xPublic: keys.xPublic };
  return { phrase, keys };
}

/**
 * The strongest forgery a repo writer can make under a set's real id since ids are self-certifying:
 * the real file's id and whole authority (birth and changes, copied as they are), with a header and
 * value lines Mallory signs herself, every wrap and box made properly under the real id. Only the
 * check that the header's owner is the one its authority names, and that it signed, stands between.
 */
export function onRealAuthority(
  realText: string,
  mallory: DeviceKeys,
  random: RandomBytes,
  options: { members?: DeviceKeys[]; values?: { name: string; value: string }[]; ownerLabel?: string; recovery?: Pick<DeviceKeys, 'edPublic' | 'xPublic' | 'deviceId'> | null; rev?: number } = {},
): { text: string; dataKey: Uint8Array } {
  const real = fileOf(realText).header;
  const set = real.set;
  const epoch = real.epoch + 1;
  const time = real.time + 1;
  const dataKey = random(32);
  const scope = { set, epoch };
  const members = [
    envMemberRecord(dataKey, scope, { ...publicHalf(mallory), label: options.ownerLabel ?? 'Mallory · Pixel 9', form: 'phone' }, 'owner', time),
    ...(options.members ?? []).map((m, i) => envMemberRecord(dataKey, scope, { ...publicHalf(m), label: `Member ${i} · Phone`, form: 'phone' }, 'member', time)),
  ];
  const recovery = options.recovery ? envRecoveryRecord(dataKey, scope, options.recovery) : null;
  const header = signEnvHeader(
    { format: ENV_FORMAT, set, name: real.name, rev: options.rev ?? real.rev + 1, epoch, authority: real.authority, members, recovery, time, signer: mallory.deviceId },
    mallory,
  );
  const values = (options.values ?? [{ name: 'API_KEY', value: 'sk_mallory' }]).map(({ name, value }) =>
    signEnvValueLine({ name, version: 9, author: mallory.deviceId, time, box: sealEnvValue(dataKey, { set, epoch, name, version: 9 }, value, random) }, scope, mallory),
  );
  return { text: writeEnvFile({ header, values }), dataKey };
}
