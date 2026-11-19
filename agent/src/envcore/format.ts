/**
 * The set file as text: `.authdeck/<set>.env`, UTF-8, LF line ends, always ending in "\n".
 *
 * Canonical layout, exactly as writeEnvFile writes it (one space between fields; byte fields are
 * unpadded base64url; times are integer ms):
 *
 *   # AuthDeck env set: names plain, values encrypted.
 *   # Change it with `authdeck env` or the app.
 *   @set <name> format=<n> id=<set> rev=<n> epoch=<n> time=<ms>
 *   @birth time=<ms> nonce=<nonce> ed=<ed> x=<x> recovery=<ed>.<x>|- sig=<sig>
 *   @authority <n> <takeover|recovery> time=<ms> prev=<hash> ed=<ed> x=<x> recovery=<ed>.<x>|- sig=<sig>
 *   @member <id> <owner|member> form=<phone|tablet|-> since=<ms> ed=<ed> x=<x> key=<e>.<ct> <label as a JSON string>
 *   @recovery <id> ed=<ed> x=<x> key=<e>.<ct>
 *   @sig <signer> <sig>
 *   <NAME>=enc:<epoch>:<n>.<ct>.<c> ; v<version> <author> <time> <sig>
 *   <NAME>=deleted ; v<version> <author> <time> <sig>
 *
 * There is one @authority line per change of the authority (EnvAuthority), in order, none for a set
 * never taken over. A sealed key's `r` is not written: it is the member's (or recovery identity's) `x`. A box's
 * epoch is the number after `enc:`. Comment lines (`#`) and blank lines are skipped on reading;
 * everything else must be one of the lines above, in this order (header lines, then values).
 * Signatures and hashes never cover this text: they cover canonical JSON (signing.ts), so the
 * layout can't change what a signature means.
 */
import { cleanJoinName } from '../vault/approval';
import { fromBase64Url, toBase64Url, utf8Encode } from '../vault/bytes';
import { deviceIdFor, isUsableEd25519Key, isUsableSealingKey, sha256Bytes, type Box, type SealedKey } from '../vault/crypto';
import { isId } from '../vault/entry';
import { EnvFileRefused } from './errors';
import {
  ENV_FILE_EXTENSION,
  ENV_FOLDER,
  ENV_FORMAT,
  ENV_LIMITS,
  ENV_NAME_PATTERN,
  ENV_SET_NAME_PATTERN,
  type EnvAuthority,
  type EnvAuthorityChange,
  type EnvBirth,
  type EnvFileProblem,
  type EnvHeader,
  type EnvPublicKeys,
  type EnvMember,
  type EnvPlainValue,
  type EnvRecovery,
  type EnvSetFile,
  type EnvValueLine,
} from './types';

/** The two comment lines every written file starts with. */
export const ENV_FILE_PREAMBLE = ['# AuthDeck env set: names plain, values encrypted.', '# Change it with `authdeck env` or the app.'] as const;

/** A parsed file, with where each part sat, so a problem can name its line (1-based). */
export interface EnvParsedFile {
  file: EnvSetFile;
  /** Line of the `@set` line. */
  headerLine: number;
  /** Line of each value line, index-aligned with `file.values`. */
  valueLines: number[];
}

export type EnvParseResult = { ok: true; parsed: EnvParsedFile } | { ok: false; problem: EnvFileProblem };

const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const NONCE_BYTES = 12;
const BIRTH_NONCE_BYTES = 16;
const HASH_BYTES = 32;
const GCM_TAG_BYTES = 16;
const SEALED_CT_BYTES = KEY_BYTES + GCM_TAG_BYTES;
const DELETED = 'deleted';
const NO_VALUE = '-';
const VALUE_SEPARATOR = ' ; ';
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BOX_TEXT = /^enc:(0|[1-9][0-9]*):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const CONFLICT_MARKER = /^(<{7}|>{7}|\|{7})( |$)|^={7}$/;

/** Plain bytes inside a value box: AES-GCM adds exactly its tag. */
export function plainBytesOfBox(box: Box): number {
  return fromBase64Url(box.ct).length - GCM_TAG_BYTES;
}

function unreadable(line: number, detail: string): never {
  throw new EnvFileRefused({ kind: 'unreadable', line, detail });
}

function decimal(text: string, line: number, what: string): number {
  const value = Number(text);
  if (!DECIMAL.test(text) || !Number.isSafeInteger(value)) unreadable(line, `${what} isn't a whole number`);
  return value;
}

function field(token: string | undefined, key: string, line: number): string {
  const prefix = `${key}=`;
  if (token === undefined || !token.startsWith(prefix)) unreadable(line, `expected ${prefix}`);
  return token.slice(prefix.length);
}

function bytesField(text: string, length: number, line: number, what: string): string {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text);
  } catch {
    unreadable(line, `${what} isn't base64url`);
  }
  if (bytes.length !== length) unreadable(line, `${what} has the wrong length`);
  return text;
}

function idField(text: string | undefined, line: number, what: string): string {
  if (!isId(text)) unreadable(line, `${what} isn't an id`);
  return text;
}

function sealedKeyField(text: string, recipient: string, line: number): SealedKey {
  const parts = text.split('.');
  if (parts.length !== 2) unreadable(line, 'key= needs two parts');
  return { e: bytesField(parts[0]!, KEY_BYTES, line, 'the wrap'), r: recipient, ct: bytesField(parts[1]!, SEALED_CT_BYTES, line, 'the wrap') };
}

function publicKeys(tokens: string[], at: number, line: number): { ed: string; x: string } {
  const ed = bytesField(field(tokens[at], 'ed', line), KEY_BYTES, line, 'ed');
  const x = bytesField(field(tokens[at + 1], 'x', line), KEY_BYTES, line, 'x');
  if (!isUsableEd25519Key(fromBase64Url(ed))) unreadable(line, "ed isn't a usable signing key");
  if (!isUsableSealingKey(fromBase64Url(x))) unreadable(line, "x isn't a usable sealing key");
  return { ed, x };
}

function checkIdMatchesKey(id: string, ed: string, line: number): void {
  if (deviceIdFor(fromBase64Url(ed)) !== id) unreadable(line, "the id doesn't match its signing key");
}

function parseLabel(text: string, line: number): string {
  let label: unknown;
  try {
    label = JSON.parse(text);
  } catch {
    unreadable(line, "the label isn't a quoted string");
  }
  if (typeof label !== 'string' || JSON.stringify(label) !== text) unreadable(line, "the label isn't a quoted string");
  if (label === '' || cleanJoinName(label) !== label) unreadable(line, 'the label has characters that are not allowed');
  return label;
}

type HeaderFields = Omit<EnvHeader, 'authority' | 'members' | 'recovery' | 'signer' | 'sig'>;

function parseSetLine(line: string, n: number): HeaderFields {
  const tokens = line.split(' ');
  const formatText = field(tokens[2], 'format', n);
  const format = decimal(formatText, n, 'format');
  if (format > ENV_FORMAT) throw new EnvFileRefused({ kind: 'newer-format', format });
  if (format !== ENV_FORMAT) unreadable(n, `format ${format} isn't one AuthDeck writes`);
  if (tokens.length !== 7) unreadable(n, '@set has the wrong number of fields');
  const name = tokens[1]!;
  if (!ENV_SET_NAME_PATTERN.test(name)) unreadable(n, "the set name isn't allowed");
  const set = idField(field(tokens[3], 'id', n), n, 'id');
  const rev = decimal(field(tokens[4], 'rev', n), n, 'rev');
  const epoch = decimal(field(tokens[5], 'epoch', n), n, 'epoch');
  const time = decimal(field(tokens[6], 'time', n), n, 'time');
  if (rev < 1 || epoch < 1) unreadable(n, 'rev and epoch start at 1');
  return { format: ENV_FORMAT, set, name, rev, epoch, time };
}

/** `recovery=<ed>.<x>` or `recovery=-`. */
function recoveryKeysField(token: string | undefined, n: number): EnvPublicKeys | null {
  const text = field(token, 'recovery', n);
  if (text === NO_VALUE) return null;
  const parts = text.split('.');
  if (parts.length !== 2) unreadable(n, 'recovery= needs two keys or -');
  return publicKeys([`ed=${parts[0]}`, `x=${parts[1]}`], 0, n);
}

function parseBirthLine(line: string, n: number): EnvBirth {
  const tokens = line.split(' ');
  if (tokens.length !== 7) unreadable(n, '@birth has the wrong number of fields');
  const time = decimal(field(tokens[1], 'time', n), n, 'time');
  const nonce = bytesField(field(tokens[2], 'nonce', n), BIRTH_NONCE_BYTES, n, 'the nonce');
  const owner = publicKeys(tokens, 3, n);
  const recovery = recoveryKeysField(tokens[5], n);
  const sig = bytesField(field(tokens[6], 'sig', n), SIGNATURE_BYTES, n, 'the signature');
  return { owner, recovery, time, nonce, sig };
}

function parseAuthorityLine(line: string, n: number): EnvAuthorityChange {
  const tokens = line.split(' ');
  if (tokens.length !== 9) unreadable(n, '@authority has the wrong number of fields');
  const number = decimal(tokens[1]!, n, 'the change number');
  const kind = tokens[2];
  if (kind !== 'takeover' && kind !== 'recovery') unreadable(n, 'the change is neither takeover nor recovery');
  const time = decimal(field(tokens[3], 'time', n), n, 'time');
  const prev = bytesField(field(tokens[4], 'prev', n), HASH_BYTES, n, 'prev');
  const owner = publicKeys(tokens, 5, n);
  const recovery = recoveryKeysField(tokens[7], n);
  const sig = bytesField(field(tokens[8], 'sig', n), SIGNATURE_BYTES, n, 'the signature');
  return { kind, n: number, prev, owner, recovery, time, sig };
}

const MEMBER_FIELDS = 8;

function parseMemberLine(line: string, n: number): EnvMember {
  const tokens = line.split(' ');
  if (tokens.length <= MEMBER_FIELDS) unreadable(n, '@member has the wrong number of fields');
  const id = idField(tokens[1], n, 'the member id');
  const role = tokens[2];
  if (role !== 'owner' && role !== 'member') unreadable(n, 'the role is neither owner nor member');
  const formText = field(tokens[3], 'form', n);
  if (formText !== 'phone' && formText !== 'tablet' && formText !== NO_VALUE) unreadable(n, 'form is not phone, tablet or -');
  const since = decimal(field(tokens[4], 'since', n), n, 'since');
  const { ed, x } = publicKeys(tokens, 5, n);
  checkIdMatchesKey(id, ed, n);
  const key = sealedKeyField(field(tokens[7], 'key', n), x, n);
  const label = parseLabel(tokens.slice(MEMBER_FIELDS).join(' '), n);
  return { id, role, label, form: formText === NO_VALUE ? null : formText, ed, x, key, since };
}

function parseRecoveryLine(line: string, n: number): EnvRecovery {
  const tokens = line.split(' ');
  if (tokens.length !== 5) unreadable(n, '@recovery has the wrong number of fields');
  const id = idField(tokens[1], n, 'the recovery id');
  const { ed, x } = publicKeys(tokens, 2, n);
  checkIdMatchesKey(id, ed, n);
  return { id, ed, x, key: sealedKeyField(field(tokens[4], 'key', n), x, n) };
}

function parseBox(text: string, n: number): Box | null {
  if (text === DELETED) return null;
  const match = BOX_TEXT.exec(text);
  if (!match) unreadable(n, "the value isn't enc:<key>:<box> or deleted");
  const epoch = decimal(match[1]!, n, 'the key number');
  if (epoch < 1) unreadable(n, 'key numbers start at 1');
  const nonce = bytesField(match[2]!, NONCE_BYTES, n, 'the nonce');
  const commit = bytesField(match[4]!, KEY_BYTES, n, 'the commitment');
  let ct: Uint8Array;
  try {
    ct = fromBase64Url(match[3]!);
  } catch {
    unreadable(n, "the ciphertext isn't base64url");
  }
  if (ct.length < GCM_TAG_BYTES) unreadable(n, 'the ciphertext is too short');
  return { epoch, n: nonce, ct: match[3]!, c: commit };
}

function parseValueLine(line: string, n: number): EnvValueLine {
  if (line.startsWith('@')) unreadable(n, 'a header line after @sig');
  const equals = line.indexOf('=');
  if (equals < 0) unreadable(n, 'not a NAME=value line');
  const name = line.slice(0, equals);
  if (!ENV_NAME_PATTERN.test(name)) throw new EnvFileRefused({ kind: 'bad-name', line: n, name });
  const rest = line.slice(equals + 1).split(VALUE_SEPARATOR);
  if (rest.length !== 2) unreadable(n, `expected one "${VALUE_SEPARATOR.trim()}" after the value`);
  const box = parseBox(rest[0]!, n);
  const meta = rest[1]!.split(' ');
  if (meta.length !== 4 || !meta[0]!.startsWith('v')) unreadable(n, 'expected v<version> <author> <time> <signature>');
  const version = decimal(meta[0]!.slice(1), n, 'the version');
  if (version < 1) unreadable(n, 'versions start at 1');
  const author = idField(meta[1], n, 'the author');
  const time = decimal(meta[2]!, n, 'the time');
  const sig = bytesField(meta[3]!, SIGNATURE_BYTES, n, 'the signature');
  return { name, version, author, time, box, sig };
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Reads the lines in order: @set, @member lines, an optional @recovery, @sig, then values. */
function readLines(lines: readonly string[]): EnvParsedFile {
  let fields: HeaderFields | null = null;
  let headerLine = 0;
  let authority: EnvAuthority | null = null;
  const members: EnvMember[] = [];
  let recovery: EnvRecovery | null = null;
  let signed: { signer: string; sig: string } | null = null;
  const values: EnvValueLine[] = [];
  const valueLines: number[] = [];
  const seenNames = new Set<string>();
  let plainTotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (line.includes('\r')) unreadable(n, 'a Windows line end');
    if (line === '' || line.startsWith('#')) continue;
    if (!fields) {
      if (!line.startsWith('@set ')) unreadable(n, 'expected the @set line first');
      fields = parseSetLine(line, n);
      headerLine = n;
    } else if (!authority) {
      if (!line.startsWith('@birth ')) unreadable(n, 'expected the @birth line after @set');
      authority = { birth: parseBirthLine(line, n), changes: [] };
    } else if (!signed) {
      if (line.startsWith('@authority ')) {
        if (members.length > 0 || recovery) unreadable(n, '@authority after @member');
        authority.changes.push(parseAuthorityLine(line, n));
      } else if (line.startsWith('@member ')) {
        if (recovery) unreadable(n, '@member after @recovery');
        if (members.length === ENV_LIMITS.members) throw new EnvFileRefused({ kind: 'too-large', limit: 'members' });
        const member = parseMemberLine(line, n);
        if (members.some((other) => other.id === member.id)) unreadable(n, 'the same member twice');
        members.push(member);
      } else if (line.startsWith('@recovery ')) {
        if (recovery) unreadable(n, 'a second @recovery');
        recovery = parseRecoveryLine(line, n);
        if (members.some((member) => member.id === recovery!.id)) unreadable(n, 'the recovery identity is also a member');
      } else if (line.startsWith('@sig ')) {
        const tokens = line.split(' ');
        if (tokens.length !== 3) unreadable(n, '@sig has the wrong number of fields');
        signed = { signer: idField(tokens[1], n, 'the signer'), sig: bytesField(tokens[2]!, SIGNATURE_BYTES, n, 'the signature') };
        if (members.filter((member) => member.role === 'owner').length !== 1) unreadable(n, 'the member list needs exactly one owner');
      } else {
        unreadable(n, 'expected @authority, @member, @recovery or @sig');
      }
    } else {
      const value = parseValueLine(line, n);
      if (seenNames.has(value.name)) throw new EnvFileRefused({ kind: 'duplicate-name', line: n, name: value.name });
      seenNames.add(value.name);
      if (values.length === ENV_LIMITS.names) throw new EnvFileRefused({ kind: 'too-large', limit: 'names' });
      if (value.box) {
        const plain = plainBytesOfBox(value.box);
        if (plain > ENV_LIMITS.valueBytes) throw new EnvFileRefused({ kind: 'too-large', limit: 'value', name: value.name });
        plainTotal += plain;
        if (plainTotal > ENV_LIMITS.valueTotalBytes) throw new EnvFileRefused({ kind: 'too-large', limit: 'values' });
      }
      values.push(value);
      valueLines.push(n);
    }
  }
  if (!fields) unreadable(Math.max(1, lines.length), 'no @set line');
  if (!authority) unreadable(Math.max(1, lines.length), 'no @birth line');
  if (!signed) unreadable(Math.max(1, lines.length), 'the member list has no @sig line');
  return { file: { header: { ...fields, authority, members, recovery, ...signed }, values }, headerLine, valueLines };
}

/**
 * Reads a set file's text into the model. Checks shape only, no signatures: size (`too-large`
 * 'file', checked first, on UTF-8 bytes), git conflict markers (`conflict-markers`), the format
 * number (`newer-format`), every line's syntax, base64url fields and lengths (`unreadable`),
 * names against ENV_NAME_PATTERN (`bad-name`), each name once (`duplicate-name`), and every cap
 * (`too-large`): names, members, and the value sizes, read from the ciphertexts (AES-GCM adds
 * exactly 16 bytes, so a box's plain size is known without its key). Never throws.
 *
 * Also checked here, as `unreadable`: member and recovery ids are deviceIdFor(ed) of keys that
 * are usable, no id twice, exactly one owner, rev and epoch from 1. Signatures and the authority
 * chain are verify.ts's.
 */
export function parseEnvFile(text: string): EnvParseResult {
  if (utf8Encode(text).length > ENV_LIMITS.fileBytes) return { ok: false, problem: { kind: 'too-large', limit: 'file' } };
  const lines = splitLines(text);
  const marker = lines.findIndex((line) => CONFLICT_MARKER.test(line));
  if (marker >= 0) return { ok: false, problem: { kind: 'conflict-markers', line: marker + 1 } };
  try {
    return { ok: true, parsed: readLines(lines) };
  } catch (err) {
    if (err instanceof EnvFileRefused) return { ok: false, problem: err.problem };
    throw err;
  }
}

function sealedKeyText(key: SealedKey, recipient: string): string {
  if (key.r !== recipient) throw new Error("A wrap names a sealing key other than its holder's; the file can't record it.");
  return `${key.e}.${key.ct}`;
}

function setLine(header: EnvHeader): string {
  return `@set ${header.name} format=${header.format} id=${header.set} rev=${header.rev} epoch=${header.epoch} time=${header.time}`;
}

function recoveryKeysText(recovery: EnvPublicKeys | null): string {
  return `recovery=${recovery ? `${recovery.ed}.${recovery.x}` : NO_VALUE}`;
}

function birthLine(birth: EnvBirth): string {
  return `@birth time=${birth.time} nonce=${birth.nonce} ed=${birth.owner.ed} x=${birth.owner.x} ${recoveryKeysText(birth.recovery)} sig=${birth.sig}`;
}

function authorityLine(change: EnvAuthorityChange): string {
  const keys = `ed=${change.owner.ed} x=${change.owner.x} ${recoveryKeysText(change.recovery)}`;
  return `@authority ${change.n} ${change.kind} time=${change.time} prev=${change.prev} ${keys} sig=${change.sig}`;
}

function memberLine(member: EnvMember): string {
  const keys = `ed=${member.ed} x=${member.x} key=${sealedKeyText(member.key, member.x)}`;
  return `@member ${member.id} ${member.role} form=${member.form ?? NO_VALUE} since=${member.since} ${keys} ${JSON.stringify(member.label)}`;
}

function recoveryLine(recovery: EnvRecovery): string {
  return `@recovery ${recovery.id} ed=${recovery.ed} x=${recovery.x} key=${sealedKeyText(recovery.key, recovery.x)}`;
}

function valueLine(line: EnvValueLine): string {
  const value = line.box ? `enc:${line.box.epoch}:${line.box.n}.${line.box.ct}.${line.box.c}` : DELETED;
  return `${line.name}=${value}${VALUE_SEPARATOR}v${line.version} ${line.author} ${line.time} ${line.sig}`;
}

/** The problem a model's names and caps have, with lines numbered as writeEnvFile would write them. */
function modelProblem(file: EnvSetFile): EnvFileProblem | null {
  if (file.header.members.length > ENV_LIMITS.members) return { kind: 'too-large', limit: 'members' };
  if (file.values.length > ENV_LIMITS.names) return { kind: 'too-large', limit: 'names' };
  const authorityLines = 1 + file.header.authority.changes.length;
  const firstValueLine = ENV_FILE_PREAMBLE.length + 1 + authorityLines + file.header.members.length + (file.header.recovery ? 1 : 0) + 2;
  const seen = new Set<string>();
  let plainTotal = 0;
  for (const [index, line] of file.values.entries()) {
    const n = firstValueLine + index;
    if (!ENV_NAME_PATTERN.test(line.name)) return { kind: 'bad-name', line: n, name: line.name };
    if (seen.has(line.name)) return { kind: 'duplicate-name', line: n, name: line.name };
    seen.add(line.name);
    if (!line.box) continue;
    const plain = plainBytesOfBox(line.box);
    if (plain > ENV_LIMITS.valueBytes) return { kind: 'too-large', limit: 'value', name: line.name };
    plainTotal += plain;
  }
  return plainTotal > ENV_LIMITS.valueTotalBytes ? { kind: 'too-large', limit: 'values' } : null;
}

/**
 * Writes the model as canonical text (the layout above). parseEnvFile(writeEnvFile(f)) gives f
 * back, and writeEnvFile(parse(t)) === t for any t this function wrote. Throws EnvFileRefused
 * (`bad-name`, `duplicate-name`, `too-large`) for a model no reader would accept.
 */
export function writeEnvFile(file: EnvSetFile): string {
  const problem = modelProblem(file);
  if (problem) throw new EnvFileRefused(problem);
  const { header } = file;
  const lines = [
    ...ENV_FILE_PREAMBLE,
    setLine(header),
    birthLine(header.authority.birth),
    ...header.authority.changes.map(authorityLine),
    ...header.members.map(memberLine),
    ...(header.recovery ? [recoveryLine(header.recovery)] : []),
    `@sig ${header.signer} ${header.sig}`,
    ...file.values.map(valueLine),
  ];
  const text = `${lines.join('\n')}\n`;
  if (utf8Encode(text).length > ENV_LIMITS.fileBytes) throw new EnvFileRefused({ kind: 'too-large', limit: 'file' });
  return text;
}

/** Base64url SHA-256 of the file's UTF-8 bytes: protocol `fileHash`, the base env.file.write compares. */
export function envFileHash(text: string): string {
  return toBase64Url(sha256Bytes(utf8Encode(text)));
}

/** Where a set lives in a working tree: `.authdeck/<name>.env`. Throws for a name outside ENV_SET_NAME_PATTERN. */
export function envSetFilePath(setName: string): string {
  if (!ENV_SET_NAME_PATTERN.test(setName)) throw new Error(`"${setName}" can't be a set name: use lower-case letters, digits, ".", "_" and "-", starting with a letter or digit.`);
  return `${ENV_FOLDER}/${setName}${ENV_FILE_EXTENSION}`;
}

/**
 * Checks plain values before they are sealed or sent: names (ENV_NAME_PATTERN, `bad-name`, line
 * = 1-based index in `values`), each name once (`duplicate-name`), and the caps (`too-large`:
 * 'names', 'value' with the name, 'values' for the UTF-8 total). Null when all pass. The CLI
 * runs it on a .env before push and init; sealing runs it again.
 */
export function checkEnvPlainValues(values: readonly EnvPlainValue[]): EnvFileProblem | null {
  if (values.length > ENV_LIMITS.names) return { kind: 'too-large', limit: 'names' };
  const seen = new Set<string>();
  let total = 0;
  for (const [index, { name, value }] of values.entries()) {
    if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) return { kind: 'bad-name', line: index + 1, name: String(name) };
    if (seen.has(name)) return { kind: 'duplicate-name', line: index + 1, name };
    seen.add(name);
    const bytes = utf8Encode(value).length;
    if (bytes > ENV_LIMITS.valueBytes) return { kind: 'too-large', limit: 'value', name };
    total += bytes;
  }
  return total > ENV_LIMITS.valueTotalBytes ? { kind: 'too-large', limit: 'values' } : null;
}
