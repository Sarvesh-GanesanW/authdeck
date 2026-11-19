/**
 * Shape checks for what a paired computer sends inside the encrypted session. The key proves who
 * sent a message, not that it is well formed: a buggy or hostile agent can send any JSON, and a
 * single unchecked field read inside a WebSocket handler is a crash in a release build.
 */
import {
  ENV_FEATURE,
  type AgentFeature,
  type AgentInfo,
  type AppIcon,
  type EnvEventMessage,
  type EnvEventName,
  type EnvMethod,
  type EventMessage,
  type EventName,
  type FocusInfo,
  type HelloResponse,
  type Method,
  type Platform,
  type ProtocolError,
  type Response,
} from '../protocol';
import { ENV_LIMITS } from '../envcore/types';
import { sealProofShapeProblem } from '../vault/sealProof';
import { MAX_ICON_BASE64_CHARS, isIconSizedPng } from './pngIcon';

export { MAX_ICON_BASE64_CHARS };

type Fields = Record<string, unknown>;

const PLATFORMS: ReadonlySet<string> = new Set<Platform>(['macos', 'windows', 'linux']);
const CANCEL_REASONS: ReadonlySet<string> = new Set(['cancelled', 'expired', 'disconnected', 'taken']);

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);

function hasStrings(value: unknown, keys: readonly string[]): value is Fields {
  return isFields(value) && keys.every((key) => isString(value[key]));
}

/** A string of at most `max` UTF-16 units. */
const isText =
  (max: number) =>
  (value: unknown): value is string =>
    isString(value) && value.length <= max;
const isOptionalText = (max: number) => (value: unknown): boolean => value === undefined || isText(max)(value);
const isListOf = (value: unknown, max: number, check: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= max && value.every(check);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPort = (value: unknown): boolean => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
const isOptionalNumber = (value: unknown): boolean => value === undefined || isNumber(value);
const isStringOrNull = (value: unknown): boolean => value === null || isString(value);
const isArrayOf = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const isRecordOf = (value: unknown, check: (item: unknown) => boolean): boolean => isFields(value) && Object.values(value).every(check);
const isOneOf =
  (allowed: readonly string[]) =>
  (value: unknown): boolean =>
    isString(value) && allowed.includes(value);

/**
 * The most the app takes from a computer, field by field. Everything here is drawn, and some of it
 * is saved (app ids and names go into keys, folder paths into pages), so a computer must not be
 * able to make the saved state too large to load again. Checked with each shape below, and again
 * on load (storedData.ts). Lengths are UTF-16 units.
 */
export const LIMITS = {
  /** apps.list: ids are bundle ids, desktop file ids or paths. */
  appId: 256,
  appName: 128,
  appDetail: 1024,
  apps: 2000,
  /** apps.icons answers at most the 48 ids asked for at once. */
  iconsPerReply: 48,
  /** fs.list */
  fsName: 1024,
  fsPath: 4096,
  fsEntries: 10_000,
  fsRoots: 64,
  /** run: the agent keeps the last 8,000 characters of a background command's output. */
  runOutput: 8192,
  runNote: 1000,
  /** focus.get and the focus event. */
  focusName: 128,
  /** Error replies. */
  errorCode: 64,
  errorText: 1000,
  /**
   * The handshake and /hello. The name is cut to 64 characters for display (trust.ts cleanName),
   * but only after this cap: a raw name of megabytes would cost that much to clean first.
   */
  agentName: 1024,
  /** "0.2.0", "1.0.0-beta.1+build": drawn in Settings as is. */
  agentVersion: 32,
  /** vault.forks.read: at most one fork proof and one seal proof per log, and a vault holds at most 256 (MAX_IDENTITIES). */
  vaultForkProofs: 256,
  vaultSealProofs: 256,
  /** vault.list: the paired device that retired a vault (the agent keeps 80 characters). */
  retiredBy: 128,
} as const;

/** A version as the agent's package.json gives it: semver characters only, so it draws as one short word. */
const AGENT_VERSION_PATTERN = new RegExp(`^[0-9A-Za-z.+-]{1,${LIMITS.agentVersion}}$`);
/** linkFingerprint: 16 bytes in base64url without padding. */
const LINK_FINGERPRINT = /^[A-Za-z0-9_-]{22}$/;
/** A vault id (vault/entry.ts isId). */
const VAULT_ID = /^[A-Za-z0-9_-]{22}$/;

export function isProtocolError(value: unknown): value is ProtocolError {
  return (
    isFields(value) &&
    isText(LIMITS.errorCode)(value.code) &&
    isText(LIMITS.errorText)(value.message) &&
    isOptionalText(LIMITS.errorText)(value.hint)
  );
}

export function isFocusInfo(value: unknown): value is FocusInfo {
  return (
    isFields(value) &&
    typeof value.supported === 'boolean' &&
    (value.appId === null || isText(LIMITS.appId)(value.appId)) &&
    isText(LIMITS.focusName)(value.name)
  );
}

/** An app as apps.list sends it, within LIMITS; the starter deck and saved keys copy its id and name. */
export const isAppEntry = (v: unknown): boolean =>
  isFields(v) &&
  isText(LIMITS.appId)(v.id) &&
  isText(LIMITS.appName)(v.name) &&
  isOptionalText(LIMITS.appDetail)(v.detail) &&
  typeof v.hasIcon === 'boolean';
const PADDING = 0x3d; // '='

const isBase64Char = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;

/**
 * Standard base64 (RFC 4648 section 4): the A-Z a-z 0-9 + / alphabet, a length that is a multiple
 * of 4, and "=" only as one or two final padding characters. A loop rather than a regex, so a long
 * icon can't exhaust a backtracking engine.
 */
export function isBase64(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) return false;
  const padding = text.charCodeAt(text.length - 1) !== PADDING ? 0 : text.charCodeAt(text.length - 2) === PADDING ? 2 : 1;
  for (let i = 0; i < text.length - padding; i++) if (!isBase64Char(text.charCodeAt(i))) return false;
  return true;
}

/**
 * An app icon as the app keeps it: a PNG of at most 256 x 256 pixels and 256 KB (pngIcon.ts).
 * SVG is refused: react-native-svg follows <use> references with no cycle or depth guard, so one
 * crafted file closes the app every time it is drawn. Checked again wherever one is reloaded or drawn.
 */
export function isAppIcon(v: unknown): v is AppIcon {
  if (!hasStrings(v, ['data']) || v.mime !== 'image/png') return false;
  const data = v.data as string;
  return data.length <= MAX_ICON_BASE64_CHARS && isBase64(data) && isIconSizedPng(data);
}
const isFsEntry = (v: unknown): boolean =>
  isFields(v) && isText(LIMITS.fsName)(v.name) && isText(LIMITS.fsPath)(v.path) && isOneOf(['dir', 'file'])(v.kind);
const isFsListResult = (v: unknown): boolean =>
  isFields(v) &&
  isText(LIMITS.fsPath)(v.path) &&
  isText(LIMITS.fsPath)(v.home) &&
  (v.parent === null || isText(LIMITS.fsPath)(v.parent)) &&
  isListOf(v.entries, LIMITS.fsEntries, isFsEntry) &&
  isListOf(v.roots, LIMITS.fsRoots, isFsEntry) &&
  isOneOf(['/', '\\'])(v.sep);
const isRunResult = (v: unknown): boolean =>
  isFields(v) &&
  isNumber(v.durationMs) &&
  isOptionalNumber(v.exitCode) &&
  isOptionalText(LIMITS.runOutput)(v.output) &&
  isOptionalText(LIMITS.runNote)(v.note);
const isIconRecord = (v: unknown): boolean =>
  isFields(v) && Object.keys(v).length <= LIMITS.iconsPerReply && Object.values(v).every((icon) => icon === null || isAppIcon(icon));
const isLengths = (v: unknown): boolean => isRecordOf(v, isNumber);
/** A time a Date can show (ms since 1970, up to the Date range), so "Replaced on" never reads "Invalid Date". */
const isDateTime = (v: unknown): v is number => isNumber(v) && Number.isInteger(v) && v >= 0 && v <= 8.64e15;
/** VaultSummary.retired: set when a phone replaced the vault (vault.retire). */
const isRetired = (v: unknown): boolean =>
  isFields(v) &&
  isDateTime(v.at) &&
  isDateTime(v.keptUntil) &&
  isString(v.newVaultId) &&
  VAULT_ID.test(v.newVaultId) &&
  (v.byDevice === null || isText(LIMITS.retiredBy)(v.byDevice));
/** VaultSummary.path is saved in the vault prefs (localCopy.ts), so it is capped like any folder path. */
const isVaultSummary = (v: unknown): boolean =>
  hasStrings(v, ['vaultId', 'path']) &&
  isText(LIMITS.fsPath)(v.path) &&
  isOneOf(['solo', 'personal', 'team', 'unknown'])(v.kind) &&
  isOneOf(['personal', 'team'])(v.location) &&
  isLengths(v.lengths) &&
  (v.retired === undefined || isRetired(v.retired));
const isLogPage = (v: unknown): boolean => isFields(v) && isNumber(v.from) && isArrayOf(v.lines, isString);
const isForkProof = (v: unknown): boolean =>
  hasStrings(v, ['deviceId']) && isNumber(v.seq) && Array.isArray(v.lines) && v.lines.length === 2 && v.lines.every(isString);
/** The vault core's own shape check ({entry, to, proof}); each proof is judged against its entry later. */
const isSealProof = (v: unknown): boolean => sealProofShapeProblem(v) === null;

// ---------------------------------------------------------------------------
// Env sets (protocol.ts, "Env sets"): every env message a phone receives, checked here. The env
// engine then checks what these carry (files, signatures, seals) with the env core; these only
// make sure each field has the type and size the protocol promises.
// ---------------------------------------------------------------------------

/** Caps on env messages, in UTF-16 units or items. Files and values follow the env core's caps. */
export const ENV_MESSAGE_LIMITS = {
  /** A set file as text: never more characters than ENV_LIMITS.fileBytes bytes. */
  file: ENV_LIMITS.fileBytes,
  value: ENV_LIMITS.valueBytes,
  names: ENV_LIMITS.names,
  /** Ids, hashes, keys and other short tokens. */
  token: 256,
  /** Set and member names, computer names, git authors and subjects. */
  label: 1024,
  /** "authdeck env run -- …" as typed, and each argument of a command. */
  command: 4096,
  commandArgs: 256,
  requests: 64,
  grants: 64,
  grantUses: 8,
  sets: 1000,
  joinRequests: 64,
  /** A join request file is a few hundred bytes of canonical JSON. */
  joinRequestText: 8 * 1024,
  /** env.history.read: at most 64 commits a page. */
  commits: 64,
  /** One blame entry per line of a file. */
  blame: ENV_LIMITS.fileBytes,
} as const;

const isToken = isText(ENV_MESSAGE_LIMITS.token);
const isLabel = isText(ENV_MESSAGE_LIMITS.label);
const isPath = isText(LIMITS.fsPath);
const isEnvFile = isText(ENV_MESSAGE_LIMITS.file);
const isTokenOrNull = (v: unknown): boolean => v === null || isToken(v);
const isLabelOrNull = (v: unknown): boolean => v === null || isLabel(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTimeOrNull = (v: unknown): boolean => v === null || isDateTime(v);
const isForm = (v: unknown): boolean => v === null || v === 'phone' || v === 'tablet';

const isPlainValue = (v: unknown): boolean => isFields(v) && isText(ENV_LIMITS.nameLength)(v.name) && isText(ENV_MESSAGE_LIMITS.value)(v.value);
const isPlainValues = (v: unknown): boolean => isListOf(v, ENV_MESSAGE_LIMITS.names, isPlainValue);

/** Every EnvFileProblem kind, with the fields it carries beside `kind`. */
const PROBLEM_FIELDS: Record<string, (p: Fields) => boolean> = {
  unreadable: (p) => isCount(p.line) && isLabel(p.detail),
  'conflict-markers': (p) => isCount(p.line),
  'newer-format': (p) => isCount(p.format),
  'too-large': (p) => isOneOf(['names', 'value', 'values', 'members', 'file'])(p.limit) && isOptionalText(ENV_LIMITS.nameLength)(p.name),
  'bad-name': (p) => isCount(p.line) && isLabel(p.name),
  'duplicate-name': (p) => isCount(p.line) && isLabel(p.name),
  'header-unsigned': () => true,
  'header-chain': (p) => isCount(p.rev),
  'older-header': (p) => isCount(p.seen) && isCount(p.found),
  'unsigned-line': (p) => isCount(p.line) && isLabel(p.name),
  'not-a-member': (p) => isCount(p.line) && isLabel(p.name) && isToken(p.author),
  'older-value': (p) => isCount(p.line) && isLabel(p.name) && isCount(p.seen) && isCount(p.found),
  'wrong-epoch': (p) => isCount(p.line) && isLabel(p.name) && isCount(p.epoch) && isCount(p.current),
};

export const isEnvFileProblem = (v: unknown): boolean =>
  isFields(v) && isString(v.kind) && Object.hasOwn(PROBLEM_FIELDS, v.kind) && PROBLEM_FIELDS[v.kind]!(v);

const isEnvSetSummary = (v: unknown): boolean =>
  isFields(v) &&
  isToken(v.setId) &&
  isLabel(v.name) &&
  isPath(v.path) &&
  isPath(v.repoRoot) &&
  isLabelOrNull(v.remote) &&
  isToken(v.fileHash) &&
  isCount(v.rev) &&
  isCount(v.epoch) &&
  isCount(v.variables) &&
  isCount(v.members) &&
  isCount(v.joinRequests) &&
  isTokenOrNull(v.headCommit) &&
  typeof v.uncommitted === 'boolean' &&
  (v.problem === null || (isFields(v.problem) && isEnvFileProblem(v.problem.problem) && isTokenOrNull(v.problem.commit))) &&
  isTimeOrNull(v.lastReleaseAt);

const isEnvGrant = (v: unknown): boolean =>
  isFields(v) &&
  isToken(v.grantId) &&
  isToken(v.setId) &&
  isLabel(v.setName) &&
  isPath(v.path) &&
  isDateTime(v.startedAt) &&
  isDateTime(v.endsAt) &&
  isLabel(v.by) &&
  isListOf(v.uses, ENV_MESSAGE_LIMITS.grantUses, isText(ENV_MESSAGE_LIMITS.command));

const isRequestBase = (v: Fields): boolean =>
  isToken(v.requestId) &&
  isLabel(v.setName) &&
  isPath(v.path) &&
  isPath(v.repoRoot) &&
  isLabelOrNull(v.remote) &&
  isText(ENV_MESSAGE_LIMITS.command)(v.invocation) &&
  isDateTime(v.askedAt) &&
  isDateTime(v.expiresAt);

const isSetFileFields = (v: Fields): boolean => isToken(v.setId) && isEnvFile(v.file) && isToken(v.fileHash);

const isPullTarget = (v: unknown): boolean => v === null || (isFields(v) && isPath(v.path) && typeof v.gitignored === 'boolean');

/** Each request kind's own fields. */
const REQUEST_FIELDS: Record<string, (v: Fields) => boolean> = {
  run: (v) => isReleaseRequest(v) && isListOf(v.command, ENV_MESSAGE_LIMITS.commandArgs, isText(ENV_MESSAGE_LIMITS.command)),
  pull: (v) => isReleaseRequest(v) && v.command === null,
  push: (v) => isSetFileFields(v) && isPath(v.source) && isPlainValues(v.values) && typeof v.prune === 'boolean',
  create: (v) => v.setId === null && (v.source === null || isPath(v.source)) && isPlainValues(v.values),
  'join-keys': isSetFileFields,
};

function isReleaseRequest(v: Fields): boolean {
  return (
    isSetFileFields(v) &&
    isPath(v.cwd) &&
    isLabelOrNull(v.startedIn) &&
    isPullTarget(v.target) &&
    isToken(v.oneTimeKey) &&
    isToken(v.grantKey)
  );
}

export const isEnvComputerRequest = (v: unknown): boolean =>
  isFields(v) && isString(v.kind) && Object.hasOwn(REQUEST_FIELDS, v.kind) && isRequestBase(v) && REQUEST_FIELDS[v.kind]!(v);

const isJoinRequestEntry = (v: unknown): boolean =>
  isFields(v) && isPath(v.path) && isText(ENV_MESSAGE_LIMITS.joinRequestText)(v.text) && isTokenOrNull(v.commit);

const isEnvCommit = (v: unknown): boolean =>
  isFields(v) && isToken(v.commit) && isDateTime(v.time) && isLabel(v.author) && isLabel(v.subject) && (v.file === null || isEnvFile(v.file));

const isVaultJoinRequest = (v: unknown): boolean => isFields(v) && isToken(v.ed) && isToken(v.x) && isLabel(v.name) && isToken(v.commit);
const isVaultJoinChallenge = (v: unknown): boolean =>
  isFields(v) && isToken(v.ed) && isToken(v.x) && isToken(v.vault) && isLabel(v.vaultName) && isLabel(v.name) && isToken(v.nonce);
const isEmpty = (): boolean => true;

/** One check per env method the app calls (see RESULTS). */
const ENV_RESULTS: Record<EnvMethod, (result: Fields) => boolean> = {
  'env.watch': (r) => isListOf(r.requests, ENV_MESSAGE_LIMITS.requests, isEnvComputerRequest) && isListOf(r.grants, ENV_MESSAGE_LIMITS.grants, isEnvGrant),
  'env.sets.list': (r) => isListOf(r.sets, ENV_MESSAGE_LIMITS.sets, isEnvSetSummary),
  'env.file.read': (r) =>
    isEnvFile(r.file) &&
    isToken(r.fileHash) &&
    isListOf(r.commits, ENV_MESSAGE_LIMITS.blame, isTokenOrNull) &&
    isListOf(r.requests, ENV_MESSAGE_LIMITS.joinRequests, isJoinRequestEntry),
  'env.file.write': (r) => isToken(r.fileHash),
  'env.history.read': (r) => isListOf(r.commits, ENV_MESSAGE_LIMITS.commits, isEnvCommit) && typeof r.more === 'boolean',
  'env.request.answer': isEmpty,
  'env.grant.end': isEmpty,
  'env.join.request': (r) => isToken(r.requestId) && isDateTime(r.expiresAt),
  'env.join.challenge': isEmpty,
  'env.join.reveal': isEmpty,
  'env.join.finish': isEmpty,
  'env.join.cancel': isEmpty,
};

const ENV_GRANT_END_REASONS = ['expired', 'ended-on-device', 'ended-on-computer', 'computer-locked', 'computer-slept', 'clock-jumped', 'set-changed', 'unpaired'];

/** One check per env event (see EVENT_DATA). Env events missing here are from a newer agent and are dropped. */
const ENV_EVENT_DATA: Record<EnvEventName, (data: unknown) => boolean> = {
  'env.request': (d) => isFields(d) && isEnvComputerRequest(d.request),
  'env.request.closed': (d) =>
    isFields(d) && isToken(d.requestId) && isOneOf(['answered', 'expired', 'cancelled'])(d.reason) && isOptionalText(ENV_MESSAGE_LIMITS.label)(d.by),
  'env.grants.changed': (d) =>
    isFields(d) &&
    isListOf(d.grants, ENV_MESSAGE_LIMITS.grants, isEnvGrant) &&
    (d.ended === undefined || (isFields(d.ended) && isToken(d.ended.grantId) && isToken(d.ended.setId) && isOneOf(ENV_GRANT_END_REASONS)(d.ended.reason))),
  'env.sets.changed': (d) => isFields(d) && isTokenOrNull(d.setId),
  'env.join.requested': (d) =>
    isFields(d) && isToken(d.requestId) && isToken(d.setId) && isVaultJoinRequest(d.request) && isLabel(d.fromDevice) && isDateTime(d.expiresAt),
  'env.join.challenged': (d) => isFields(d) && isToken(d.requestId) && isVaultJoinChallenge(d.challenge),
  'env.join.revealed': (d) => isFields(d) && isToken(d.requestId) && isFields(d.reveal) && isToken(d.reveal.nonce),
  'env.join.finished': (d) => isFields(d) && isToken(d.requestId) && typeof d.approved === 'boolean',
  'env.join.cancelled': (d) => isFields(d) && isToken(d.requestId) && CANCEL_REASONS.has(d.reason as string),
};

function isEnvEvent(name: string): name is EnvEventName {
  return Object.prototype.hasOwnProperty.call(ENV_EVENT_DATA, name);
}

/** Whether `method` is an env method this app knows. */
export function isEnvMethod(method: string): method is EnvMethod {
  return Object.prototype.hasOwnProperty.call(ENV_RESULTS, method);
}

/**
 * The features of an agent's info this app knows: ENV_FEATURE when listed. Anything else in the
 * list, or a list that isn't one, is ignored, so a damaged list never stops a 0.3 connection.
 */
export function agentFeatures(features: unknown): AgentFeature[] {
  return Array.isArray(features) && features.includes(ENV_FEATURE) ? [ENV_FEATURE] : [];
}

/**
 * One check per method the app calls, run before a request resolves: what a screen or the vault
 * engine receives has the shape the protocol promises. Typed over every method, so a new method
 * does not compile without its check.
 */
const RESULTS: Record<Method, (result: Fields) => boolean> = {
  ping: (r) => isNumber(r.time),
  'apps.list': (r) => isListOf(r.apps, LIMITS.apps, isAppEntry),
  'apps.icons': (r) => isIconRecord(r.icons),
  'fs.list': isFsListResult,
  'focus.get': isFocusInfo,
  run: isRunResult,
  'vault.list': (r) => isArrayOf(r.vaults, isVaultSummary) && isStringOrNull(r.teamFolder),
  'vault.read': (r) =>
    hasStrings(r, ['vaultId']) && isOneOf(['personal', 'team'])(r.location) && isRecordOf(r.logs, isLogPage) && isLengths(r.lengths),
  'vault.append': (r) => isLengths(r.lengths),
  'vault.beacons.read': (r) => isRecordOf(r.beacons, isString),
  'vault.beacons.write': () => true,
  'vault.forks.read': (r) => isListOf(r.forks, LIMITS.vaultForkProofs, isForkProof) && isListOf(r.sealProofs, LIMITS.vaultSealProofs, isSealProof),
  'vault.forks.write': () => true,
  'vault.retire': (r) => Object.keys(r).length === 1 && Number.isSafeInteger(r.keptUntil) && (r.keptUntil as number) >= 0,
  'vault.join.request': (r) => hasStrings(r, ['requestId']) && isNumber(r.expiresAt),
  'vault.join.challenge': () => true,
  'vault.join.reveal': () => true,
  'vault.join.finish': () => true,
  'vault.join.cancel': () => true,
};

/** Whether `result` has the shape `method` promises. Methods the app does not know never pass. */
export function isMethodResult(method: string, result: unknown): boolean {
  if (!isFields(result)) return false;
  if (isEnvMethod(method)) return ENV_RESULTS[method](result);
  if (!Object.prototype.hasOwnProperty.call(RESULTS, method)) return false;
  return RESULTS[method as Method](result);
}

/** One check per event the app acts on. Events missing here are from a newer agent and are dropped. */
const EVENT_DATA: Record<EventName, (data: unknown) => boolean> = {
  focus: isFocusInfo,
  'apps.changed': isFields,
  'vault.changed': (d) => hasStrings(d, ['vaultId']),
  'vault.join.requested': (d) =>
    hasStrings(d, ['requestId', 'fromDevice']) && typeof d.expiresAt === 'number' && hasStrings(d.request, ['ed', 'x', 'name', 'commit']),
  'vault.join.challenged': (d) => hasStrings(d, ['requestId']) && hasStrings(d.challenge, ['ed', 'x', 'vault', 'vaultName', 'name', 'nonce']),
  'vault.join.revealed': (d) => hasStrings(d, ['requestId']) && hasStrings(d.reveal, ['nonce']),
  'vault.join.finished': (d) => hasStrings(d, ['requestId']) && typeof d.approved === 'boolean' && isOptionalString(d.vaultId),
  'vault.join.cancelled': (d) => hasStrings(d, ['requestId']) && CANCEL_REASONS.has(d.reason as string),
};

function isKnownEvent(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENT_DATA, name);
}

/** What one decrypted session message turned out to be. */
export type SessionMessage =
  | { kind: 'event'; message: EventMessage }
  /** An env sets event (protocol "Env sets"), kept apart from the 0.3 events. */
  | { kind: 'env-event'; message: EnvEventMessage }
  /** An event this app does not know (a newer agent): safe to ignore. */
  | { kind: 'unknown-event' }
  | { kind: 'response'; message: Response }
  | { kind: 'malformed'; reason: string };

const malformed = (reason: string): SessionMessage => ({ kind: 'malformed', reason });

function readEvent(fields: Fields): SessionMessage {
  const { event, data } = fields;
  if (!isString(event)) return malformed('an event without a name');
  if (isEnvEvent(event)) {
    if (!ENV_EVENT_DATA[event](data)) return malformed(`a "${event}" event with damaged data`);
    return { kind: 'env-event', message: { event, data } as EnvEventMessage };
  }
  if (!isKnownEvent(event)) return { kind: 'unknown-event' };
  if (!EVENT_DATA[event](data)) return malformed(`a "${event}" event with damaged data`);
  return { kind: 'event', message: { event, data } as EventMessage };
}

function readResponse(fields: Fields): SessionMessage {
  const { id, ok, result, error } = fields;
  if (!isString(id)) return malformed('a reply without an id');
  if (ok === true) return isFields(result) ? { kind: 'response', message: { id, ok, result } as Response } : malformed('a reply without a result');
  if (ok === false) return isProtocolError(error) ? { kind: 'response', message: { id, ok, error } } : malformed('a failure without an error');
  return malformed('a reply that is neither success nor failure');
}

/** Reads one decrypted message: a well-formed event, a well-formed reply, or why it is neither. */
export function readSessionMessage(text: string): SessionMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return malformed('text that is not JSON');
  }
  if (!isFields(parsed)) return malformed('JSON that is not an object');
  return 'event' in parsed ? readEvent(parsed) : readResponse(parsed);
}

/** Typed against the protocol, so a rename on the agent side fails the type check here. */
const AGENT_APP: HelloResponse['app'] = 'authdeck-agent';

/** An unauthenticated /hello answer, checked before the network list shows any of it. */
export function isHelloResponse(value: unknown): value is HelloResponse {
  return (
    isFields(value) &&
    value.app === AGENT_APP &&
    (value.port === undefined || isPort(value.port)) &&
    (value.fingerprint === undefined || (isString(value.fingerprint) && LINK_FINGERPRINT.test(value.fingerprint))) &&
    isAgentInfo(value)
  );
}

/** Real ids are crypto.randomUUID(); anything else a computer sends is refused. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** "__proto__", "constructor", "toString"...: as a record key they read Object.prototype, not a saved entry. */
const OBJECT_PROTOTYPE_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/**
 * An agentId the app can key its records with. Checked wherever one arrives: the handshake, /hello,
 * and saved state read back on launch.
 */
export function isSafeAgentId(value: unknown): value is string {
  return isString(value) && AGENT_ID.test(value) && !OBJECT_PROTOTYPE_NAMES.has(value);
}

/** The computer's description of itself from the handshake and /hello, checked field by field. */
export function isAgentInfo(value: unknown): value is AgentInfo {
  return (
    isFields(value) &&
    isSafeAgentId(value.agentId) &&
    isText(LIMITS.agentName)(value.name) &&
    isString(value.platform) &&
    PLATFORMS.has(value.platform) &&
    isString(value.version) &&
    AGENT_VERSION_PATTERN.test(value.version) &&
    typeof value.protocol === 'number'
  );
}
