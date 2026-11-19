/**
 * AuthDeck wire protocol, version 2.
 *
 * Shared by the desktop agent (agent/src/protocol.ts) and the tablet app
 * (app/src/protocol.ts). The two copies must stay byte-identical; run
 * `node scripts/check-protocol.mjs` from the repo root to verify.
 *
 * Transport
 * - Discovery: GET http://<host>:<port>/authdeck/hello  -> HelloResponse (no auth, nothing secret).
 * - Session:   WebSocket ws://<host>:<port>/authdeck/ws, binary frames only. The app starts a
 *   handshake (link/handshakes.ts): Noise IK when it knows the computer's link key (paired, or
 *   read from the QR code), or CPace with the PIN followed by Noise XXpsk0. After it, every frame
 *   is an encrypted Noise transport message carrying the JSON requests, responses and events
 *   below (link/channel.ts). Being through the handshake is being authenticated.
 * - Before the channel is up the agent may answer with one text frame, `{ ok: false, error }`, to
 *   explain a refusal it cannot encrypt (wrong PIN, wrong key, other version), then it closes.
 *   A text frame from the app is a protocol 1 client: it gets `unauthorized` saying to update and
 *   pair again. A text frame after the handshake is refused and closes the connection.
 *
 * Env sets (0.4) extend protocol 2 without changing it; see the section at the end.
 */
import type { EnvFileProblem, EnvJoinRequestFile, EnvPlainValue, EnvSealedValues } from './envcore/types';

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 47474;
export const HELLO_PATH = '/authdeck/hello';
export const WS_PATH = '/authdeck/ws';

/** QR code / deep link the agent prints for pairing:
 *  authdeck://pair?v=2&n=<name>&p=<port>&h=<ip1>,<ip2>&k=<link key>&s=<secret>  (values URL-encoded)
 *  k is the computer's static X25519 link key and s its one-time pairing secret, both base64url.
 *  Scanning it is what authenticates the computer, so the link key never comes from the network. */
export const PAIR_URL_PREFIX = 'authdeck://pair';

export type Platform = 'macos' | 'windows' | 'linux';

export interface AgentInfo {
  /** Stable random id for this agent installation. */
  agentId: string;
  /** Computer name shown to the user (hostname by default). */
  name: string;
  platform: Platform;
  /** Agent semver. */
  version: string;
  protocol: number;
  /**
   * What this agent has beyond protocol 2. Absent before 0.4; 0.3 apps ignore it. An app uses a
   * feature only when it is listed here, and ignores names it doesn't know.
   */
  features?: AgentFeature[];
}

export interface HelloResponse extends AgentInfo {
  app: 'authdeck-agent';
  port: number;
  /** First 16 bytes of SHA-256 of the computer's link key, base64url. Absent before protocol 2. */
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * mod   = ⌘ on macOS, Ctrl on Windows and Linux (portable "primary" modifier)
 * ctrl  = Control everywhere (⌃ on macOS)
 * alt   = ⌥ Option on macOS, Alt elsewhere
 * shift = Shift
 * meta  = ⌘ on macOS, Windows key on Windows, Super on Linux
 */
export type Modifier = 'mod' | 'ctrl' | 'alt' | 'shift' | 'meta';

export const NAMED_KEYS = [
  'enter', 'tab', 'space', 'escape', 'backspace', 'delete',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10',
  'f11', 'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19', 'f20',
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

/**
 * Printable keys: a–z, 0–9 and these punctuation keys. macOS and Linux X11/wtype send the
 * character; Windows and ydotool press the key at its US-layout position. On non-US layouts
 * a punctuation shortcut can therefore land on a different character on Windows.
 */
export const PRINTABLE_PUNCTUATION = ['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'] as const;

export interface LaunchAction {
  type: 'launch';
  /** AppEntry.id from apps.list. Opening an app that is already running brings it to the front. */
  appId: string;
  /** Name at the time the key was made, shown if the app is missing later. */
  appName: string;
}

export interface HotkeyAction {
  type: 'hotkey';
  modifiers: Modifier[];
  /** A NamedKey, or one printable character: lowercase a–z, 0–9, or PRINTABLE_PUNCTUATION. */
  key: string;
  /** If set, bring this app to the front before pressing the keys. */
  focusAppId?: string;
}

export interface TextAction {
  type: 'text';
  /** May be empty when pressEnter is true (the key just presses Enter). */
  text: string;
  pressEnter?: boolean;
  /** A 2FA code or other secret. The agent never logs, shows or counts it; the activity list
   *  shows RunParams.label instead (e.g. "Typed a code for GitHub"). */
  secret?: boolean;
}

export interface CommandAction {
  type: 'command';
  command: string;
  /** Working folder. `~` is expanded on the agent. Falls back to RunParams.cwd, then the home folder. */
  cwd?: string;
  /** terminal: open a new terminal window and run it there (stays open).
   *  background: run hidden, wait for it, and return exit code + output. */
  mode: 'terminal' | 'background';
  /** Background mode only. Default 120. The process tree is killed when it runs out. */
  timeoutSec?: number;
}

export interface UrlAction {
  type: 'url';
  url: string;
}

export interface OpenAction {
  type: 'open';
  /** File or folder on the computer. `~` is expanded on the agent; a relative path
   *  (e.g. ".") is resolved against RunParams.cwd, then the home folder. */
  path: string;
  /** Open with this app instead of the default one (e.g. a project folder in VS Code). */
  withAppId?: string;
}

export type StepAction =
  | LaunchAction
  | HotkeyAction
  | TextAction
  | CommandAction
  | UrlAction
  | OpenAction;

export interface MacroStep {
  action: StepAction;
  /** Wait this long after the step before running the next one. */
  delayMs: number;
}

export interface MacroAction {
  type: 'macro';
  steps: MacroStep[];
}

export type Action = StepAction | MacroAction;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/**
 * An installed app on the computer.
 * id formats: macOS  `mac:<absolute .app path>`
 *             Windows `win:lnk:<absolute .lnk path>` or `win:aumid:<AppUserModelID>`
 *             Linux  `linux:<desktop file id>` (e.g. `linux:code.desktop`)
 */
export interface AppEntry {
  id: string;
  name: string;
  /** Path or bundle id, to tell apps with the same name apart. */
  detail?: string;
  hasIcon: boolean;
}

export interface AppIcon {
  mime: 'image/png' | 'image/svg+xml';
  /** base64 */
  data: string;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
}

export interface FsListResult {
  /** Absolute path that was listed. */
  path: string;
  /** Parent folder, or null at a root. */
  parent: string | null;
  /** Folders first, then files; each group sorted by name, case-insensitive. Hidden entries (dot-files) excluded. */
  entries: FsEntry[];
  /** Places to start from: home, Desktop, Documents, common code folders that exist, drives on Windows. */
  roots: FsEntry[];
  home: string;
  sep: '/' | '\\';
}

export interface FocusInfo {
  /** False when the agent cannot see the focused app (e.g. Linux on Wayland). */
  supported: boolean;
  /** AppEntry.id of the focused app when it maps to an installed app. */
  appId: string | null;
  /** Display name of the focused app, '' when unknown. */
  name: string;
}

export interface RunResult {
  durationMs: number;
  /** Background commands only. */
  exitCode?: number;
  /** Background commands only: the last 8000 characters of stdout and stderr, interleaved. */
  output?: string;
  /** Something the user should know even though it worked (e.g. a fallback was used). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Vault (docs/authenticator.md). The agent stores and checks signed log entries; it never
// holds a secret or a key.
// ---------------------------------------------------------------------------

/** Where a vault folder lives: ~/.authdeck/vault/<vaultId>, or <team folder>/<vaultId>. */
export type VaultLocation = 'personal' | 'team';

/** An entry of one device's log, named by its seq and hash. */
export interface VaultHead {
  seq: number;
  hash: string;
}

/** One signed log entry, as written to log/<deviceId>.jsonl. Byte fields are unpadded base64url. */
export interface VaultEntry {
  v: 2;
  vault: string;
  author: string;
  seq: number;
  prev: string | null;
  seen: Record<string, VaultHead>;
  time: number;
  kind: string;
  body: Record<string, unknown>;
  sig: string;
}

export interface VaultSummary {
  vaultId: string;
  /** From vault.json; a hint only. The vault.create entry is what counts. */
  kind: 'solo' | 'personal' | 'team' | 'unknown';
  location: VaultLocation;
  /** The vault folder on the computer, for display only (it may be under $AUTHDECK_HOME). */
  path: string;
  /** Lines in each device's log file. */
  lengths: Record<string, number>;
  /** Set when a phone replaced this vault with a new one (vault.retire): when, and until when the folder is kept. */
  retired?: { at: number; keptUntil: number; newVaultId: string; byDevice: string | null };
}

/** vault.retire's request, signed by the vault's active device (vault/retire.ts). */
export interface VaultRetireRequest {
  v: 1;
  vault: string;
  newVault: string;
  agentId: string;
  device: string;
  time: number;
  sig: string;
}

/**
 * A device's signed head beacon, kept as heads/<deviceId>.json and overwritten after each sync:
 * the epoch and every log's head as that device last saw them. See docs/authenticator.md.
 */
/** Two lines one identity signed that show two histories from `seq` (vault core: chain.ts ForkProof). */
export interface VaultForkProof {
  deviceId: string;
  seq: number;
  lines: [string, string];
}

/**
 * Proof that the key a key change or approval sealed to `to` doesn't open to its key check, made
 * by `to` (vault core: sealProof.ts SealProof). `proof` is base64url.
 */
export interface VaultSealProof {
  entry: string;
  to: string;
  proof: string;
}

export interface VaultBeacon {
  v: 2;
  vault: string;
  device: string;
  epoch: number;
  heads: Record<string, VaultHead>;
  time: number;
  sig: string;
}

export interface VaultReadResult {
  vaultId: string;
  location: VaultLocation;
  /** Raw lines per device file, starting at line `from`. The device checks them itself. */
  logs: Record<string, { from: number; lines: string[] }>;
  /** Total lines in each device's file, so a shorter file (a rollback) shows. */
  lengths: Record<string, number>;
}

/** Approval messages relayed between two connected devices. Byte fields are base64url. Names are cleaned by the sender (vault/approval.ts cleanJoinName) and must arrive unchanged. */
export interface VaultJoinRequest {
  ed: string;
  x: string;
  name: string;
  /** Commits to the new device's keys, name and 16-byte nonce. */
  commit: string;
}

/** The approver's answer: its keys, the vault it offers and the names the new device shows. */
export interface VaultJoinChallenge {
  ed: string;
  x: string;
  vault: string;
  vaultName: string;
  name: string;
  nonce: string;
}

export interface VaultJoinReveal {
  nonce: string;
}

/**
 * A device a vault.append took out of the vault (its removal applied, or it was removed in a
 * symmetric conflict), and whether this computer unpaired the paired phone or tablet that is it.
 */
export interface VaultRemoval {
  /** The removed device's id in the vault. */
  device: string;
  /**
   * This computer's name when it unpaired that device and cut it off; null when the computer
   * doesn't know which paired device it is (its lines came through another computer).
   */
  unpairedFrom: string | null;
}

/** Requests expire after this long. */
export const VAULT_JOIN_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Requests, responses, events
// ---------------------------------------------------------------------------

export interface RunParams {
  action: Action;
  /** Default working folder for command actions (the page's project folder). */
  cwd?: string;
  /** The key's label, shown in the agent's activity list. Older apps leave it out. */
  label?: string;
}

/** What kind of screen the paired device has; the agent shows a matching icon. */
export type DeviceForm = 'phone' | 'tablet';

/** Requests inside the encrypted channel. Pairing and sign-in happen in the handshake, not here. */
export interface Methods {
  ping: { params: Record<string, never>; result: { time: number } };
  'apps.list': { params: { refresh?: boolean }; result: { apps: AppEntry[] } };
  /** Up to 48 ids per call. Missing or icon-less apps map to null. */
  'apps.icons': {
    params: { ids: string[] };
    result: { icons: Record<string, AppIcon | null> };
  };
  'fs.list': {
    params: { path?: string; includeFiles?: boolean };
    result: FsListResult;
  };
  'focus.get': { params: Record<string, never>; result: FocusInfo };
  run: { params: RunParams; result: RunResult };
  'vault.list': { params: Record<string, never>; result: { vaults: VaultSummary[]; teamFolder: string | null } };
  /** `since[deviceId]` is the first line to return (default 0). Re-read from the seq you remember
   *  so its hash can be compared (the rollback check). A page can be partial: at most 1000 lines
   *  and 512 KB in all, devices in sorted order, so a file may stop short of `lengths` and later
   *  files may come back empty. Ask again from `from + lines.length` until every file reaches its length. */
  'vault.read': { params: { vaultId: string; since?: Record<string, number> }; result: VaultReadResult };
  /** Adds entries after checking them with the same rules as the devices. Each must be the next
   *  entry of its author and must not be waiting. One the rules reject is kept only as a placeholder
   *  for its seq, when its author is still in the vault. A first `vault.create`
   *  makes the folder (team vaults go in the team folder). `repair: true` writes back lines the
   *  folder lost, of any device: `proof[deviceId]` must name the head this device remembers the
   *  folder having for every log written, and the lines may not go past it. `removals` is there
   *  when the append took devices out of the vault (older agents never send it). */
  'vault.append': {
    params: { vaultId: string; entries: VaultEntry[]; repair?: boolean; proof?: Record<string, VaultHead> };
    result: { lengths: Record<string, number>; removals?: VaultRemoval[] };
  };
  /** Every device's head beacon file, raw (devices verify them). */
  'vault.beacons.read': { params: { vaultId: string }; result: { beacons: Record<string, string> } };
  /** Overwrites this device's beacon after checking its signature; an older beacon than the stored one is refused. */
  'vault.beacons.write': { params: { vaultId: string; beacon: VaultBeacon }; result: Record<string, never> };
  /** Proofs that a device signed two entries at one seq, kept in the folder's `forks/`, and proofs
   *  of bad seals, kept in `seals/`. Replays cut the device off at the seq (a bad seal: before its entry). */
  'vault.forks.read': { params: { vaultId: string }; result: { forks: VaultForkProof[]; sealProofs: VaultSealProof[] } };
  /** Stores a fork proof after checking both signatures, or a seal proof after checking it against
   *  the folder; the agent's own replay applies it from then on. */
  'vault.forks.write': { params: { vaultId: string; proof: VaultForkProof } | { vaultId: string; sealProof: VaultSealProof }; result: Record<string, never> };
  /** Sets a solo vault aside (any other kind is refused): the vault's active device, which
   *  replaced it with a new one, signs the request for this computer. The folder is kept until
   *  `keptUntil`, listed as retired, and still restorable with its phrase. */
  'vault.retire': { params: { vaultId: string; request: VaultRetireRequest }; result: { keptUntil: number } };
  /** New device: asks the other connected devices to approve it. */
  'vault.join.request': { params: { request: VaultJoinRequest }; result: { requestId: string; expiresAt: number } };
  /** Trusted device: answers a request. The first device to answer becomes its approver. */
  'vault.join.challenge': { params: { requestId: string; challenge: VaultJoinChallenge }; result: Record<string, never> };
  /** New device: reveals its nonce to the approver. */
  'vault.join.reveal': { params: { requestId: string; reveal: VaultJoinReveal }; result: Record<string, never> };
  /** Approver: the codes matched (approved, after writing device.add) or not. */
  'vault.join.finish': { params: { requestId: string; approved: boolean; vaultId?: string }; result: Record<string, never> };
  /** Either side stops the request. */
  'vault.join.cancel': { params: { requestId: string }; result: Record<string, never> };
}

export type Method = keyof Methods;

export interface Request<M extends Method = Method> {
  id: string;
  method: M;
  params: Methods[M]['params'];
}

export type ErrorCode =
  | 'unauthorized' // not paired, wrong link key, used QR code, or an old unencrypted app
  | 'bad_pin' // wrong pairing PIN
  | 'locked' // PIN pairing paused after wrong PINs, or another PIN pairing is under way
  | 'version' // the app and the agent speak different protocol versions
  | 'bad_request' // malformed message or invalid action
  | 'not_found' // app, file or folder does not exist
  | 'permission' // the OS refused (e.g. macOS Accessibility not granted)
  | 'missing_tool' // a required OS tool is not installed (e.g. xdotool)
  | 'unsupported' // not possible on this platform/session
  | 'timeout' // background command ran out of time
  | 'rate_limited' // too many calls of this kind from this device; wait and retry
  | 'conflict' // env sets: the file changed since the device read it; read it again and redo the change
  | 'failed'; // anything else

export interface ProtocolError {
  code: ErrorCode;
  /** One sentence saying what went wrong, written for the end user. */
  message: string;
  /** How to fix it, when there is a fix (e.g. which setting to change, what to install). */
  hint?: string;
}

export type Response<M extends Method = Method> =
  | { id: string; ok: true; result: Methods[M]['result'] }
  | { id: string; ok: false; error: ProtocolError };

export interface Events {
  /** Sent once the channel is up and whenever the focused app changes. */
  focus: FocusInfo;
  /** The installed-app list changed (sent after a rescan finds differences). */
  'apps.changed': Record<string, never>;
  /** A vault folder changed (an append, or a sync tool brought new files). Read it again. */
  'vault.changed': { vaultId: string };
  /** To every other connected device: a new device asks to join. */
  'vault.join.requested': { requestId: string; request: VaultJoinRequest; fromDevice: string; expiresAt: number };
  /** To the new device. */
  'vault.join.challenged': { requestId: string; challenge: VaultJoinChallenge };
  /** To the approver. */
  'vault.join.revealed': { requestId: string; reveal: VaultJoinReveal };
  /** To the new device. */
  'vault.join.finished': { requestId: string; approved: boolean; vaultId?: string };
  /** To the other side, and to devices that saw the request but did not answer. */
  'vault.join.cancelled': { requestId: string; reason: 'cancelled' | 'expired' | 'disconnected' | 'taken' };
}

export type EventName = keyof Events;

export interface EventMessage<E extends EventName = EventName> {
  event: E;
  data: Events[E];
}

export type ServerMessage = Response | EventMessage;

// ---------------------------------------------------------------------------
// Env sets (0.4, docs/env.md; the file model is envcore/types.ts)
//
// An extension of protocol 2, not a new version, so 0.3 apps and agents keep working:
// - An agent with env sets lists ENV_FEATURE in AgentInfo.features. An app calls env.* methods
//   only on such an agent (a 0.3 agent answers them `bad_request`).
// - An agent sends env.* events only to sessions that called env.watch. A 0.3 app never calls
//   it, and drops events it doesn't know anyway (app net/messages.ts).
// - Env messages are kept out of Methods and Events, whose shape checks on each side are
//   exhaustive over the 0.3 messages; the env code on each side checks env messages itself.
// The computer never holds a set's data key. Plain values cross the link only inside the
// encrypted channel, for a push or a new set; a release is sealed to the CLI's one-time key, or
// for a 15-minute grant to a key the agent keeps only in memory. Neither side logs values.
// ---------------------------------------------------------------------------

/** The feature name in AgentInfo.features. */
export const ENV_FEATURE = 'env-sets';
export type AgentFeature = typeof ENV_FEATURE;

/** How long a computer's request waits for a member device to answer; then the CLI exits 75. */
export const ENV_REQUEST_TTL_MS = 60 * 1000;
/** "Allow for 15 minutes": one set, on this computer, for runs and pulls. Pushes always ask. */
export const ENV_GRANT_MS = 15 * 60 * 1000;

/**
 * One set file in one working tree on this computer. A set cloned twice shows twice: files are
 * addressed by `path`, and `setId` guards against a different set at that path.
 */
export interface EnvSetSummary {
  setId: string;
  name: string;
  /** Absolute path of the set file on the computer. */
  path: string;
  /** The working tree's top folder. */
  repoRoot: string;
  /** "github.com/acme/api", from the origin remote with any credentials removed; null without one. */
  remote: string | null;
  /** Base64url SHA-256 of the file's bytes: the base env.file.write compares. */
  fileHash: string;
  /** From the file; 0 when it can't be parsed (then `problem` is set). */
  rev: number;
  epoch: number;
  /** Variables, not counting deleted ones. */
  variables: number;
  members: number;
  /** Request files waiting in .authdeck/requests/ for this set. */
  joinRequests: number;
  /** The commit HEAD points at, short. */
  headCommit: string | null;
  /** The file differs from HEAD (a change not committed yet). */
  uncommitted: boolean;
  /** The agent's own check of the file failed, with the commit that brought the line in when git knows it. */
  problem: { problem: EnvFileProblem; commit: string | null } | null;
  lastReleaseAt: number | null;
}

/** An open "Allow for 15 minutes". It lives only in the agent's memory. */
export interface EnvGrant {
  grantId: string;
  setId: string;
  setName: string;
  path: string;
  startedAt: number;
  endsAt: number;
  /** The paired device that allowed it, by its pairing name. */
  by: string;
  /** The commands that used it, newest first, at most 8: "npm run dev". */
  uses: string[];
}

/**
 * Why a grant ended. ended-on-device: End now on a phone or tablet; ended-on-computer: End now in
 * the AuthDeck Agent window; clock-jumped: the agent's clock moved more than it waited (it slept
 * with no desktop app to say so); set-changed: the file's member list or values changed under it.
 * A restart of the agent ends every grant without a message (nothing outlives the process).
 */
export type EnvGrantEndReason =
  | 'expired'
  | 'ended-on-device'
  | 'ended-on-computer'
  | 'computer-locked'
  | 'computer-slept'
  | 'clock-jumped'
  | 'set-changed'
  | 'unpaired';

/** What every request from a computer carries. */
export interface EnvRequestBase {
  requestId: string;
  /** Null only for a set that doesn't exist yet (create). */
  setId: string | null;
  setName: string;
  /** Absolute path of the set file (for create: where it will be written). */
  path: string;
  repoRoot: string;
  remote: string | null;
  /** The command as typed, for the sheet's subtitle: "authdeck env push .env.local --prune". */
  invocation: string;
  askedAt: number;
  expiresAt: number;
}

/**
 * run and pull: the values, for one process or one file. The device checks `file` and releases
 * from its own newest valid copy (adopting `file` first when it is newer and passes).
 */
export interface EnvReleaseRequest extends EnvRequestBase {
  kind: 'run' | 'pull';
  setId: string;
  /** The computer's file, exactly as the CLI checked it. */
  file: string;
  fileHash: string;
  /** run: the child's command line, as argv. Null for pull. */
  command: string[] | null;
  cwd: string;
  /** "Terminal · zsh", from the CLI's environment; null when unknown. The computer reports it; nothing proves it. */
  startedIn: string | null;
  /** pull: where .env is written and whether git ignores it. Null for run. */
  target: { path: string; gitignored: boolean } | null;
  /** Sealing public key of the CLI's one-time key pair: "Allow once" seals the values to it. */
  oneTimeKey: string;
  /** Sealing public key the agent holds only in memory: "Allow for 15 minutes" seals to it instead. */
  grantKey: string;
}

/** push: a signed change. The device works out what changed, since only it can read the current values. */
export interface EnvPushRequest extends EnvRequestBase {
  kind: 'push';
  setId: string;
  file: string;
  fileHash: string;
  /** The file read, as typed: ".env.local". */
  source: string;
  /** Every variable in `source`, in its order. Plain text: secret, never logged. */
  values: EnvPlainValue[];
  /** --prune: names missing from `values` are deleted too. */
  prune: boolean;
}

/** init in a repo without the set: the device that answers makes it and becomes its owner. */
export interface EnvCreateRequest extends EnvRequestBase {
  kind: 'create';
  setId: null;
  /** ".env" when importing one; null for an empty set. */
  source: string | null;
  /** Plain text: secret, never logged. */
  values: EnvPlainValue[];
}

/** init in a repo that has the set, by someone not in it: the device makes keys and a request file. */
export interface EnvJoinKeysRequest extends EnvRequestBase {
  kind: 'join-keys';
  setId: string;
  file: string;
  fileHash: string;
}

/** A request from a computer, shown as a sheet on top of whatever is on screen. */
export type EnvComputerRequest = EnvReleaseRequest | EnvPushRequest | EnvCreateRequest | EnvJoinKeysRequest;
export type EnvRequestKind = EnvComputerRequest['kind'];

/** A device's answer. The agent refuses one that doesn't fit the request's kind. */
export type EnvAnswer =
  | { kind: 'deny' }
  /**
   * run and pull. once: sealed to the request's oneTimeKey, which the agent can't open. grant:
   * sealed to its grantKey; the agent opens them, seals them to the CLI's key, and keeps them
   * for ENV_GRANT_MS. `source` names the copy they came from.
   */
  | { kind: 'release'; scope: 'once' | 'grant'; values: EnvSealedValues; source: { rev: number; fileHash: string } }
  /** push: the whole new file, signed by this device, and what changed by name. */
  | { kind: 'signed'; file: string; added: string[]; changed: string[]; removed: string[] }
  /** create: the new set's file. */
  | { kind: 'created'; file: string }
  /** join-keys: the request this device made and signed. */
  | { kind: 'join-keys'; request: EnvJoinRequestFile };

/** What a watching device needs on connecting: requests it may still answer, and open grants. */
export interface EnvWatchState {
  /** Oldest first. A device that connects while a request waits still gets it. */
  requests: EnvComputerRequest[];
  grants: EnvGrant[];
}

/** One commit that touched a set file, for the history view. */
export interface EnvCommit {
  /** Full hash. */
  commit: string;
  /** Committer time (ms), as git says. */
  time: number;
  /** Git's author name and subject: display only. Devices trust only the signatures in `file`. */
  author: string;
  subject: string;
  /** The set file at this commit; null when the commit deleted it or it was over the size cap. */
  file: string | null;
}

/** A join request file as it sits in the working tree. The device parses and checks it itself. */
export interface EnvJoinRequestEntry {
  /** Path relative to the repo root: ".authdeck/requests/<member>.json". */
  path: string;
  text: string;
  /** Short hash of the commit that added it; null when not committed yet. */
  commit: string | null;
}

/** Requests from a device to the agent, inside the encrypted channel. */
export interface EnvMethods {
  /**
   * Starts env requests and events for this session, routed by the member ids this device holds
   * (routing only: a paired device may already run commands on the computer). Call again on
   * reconnect, or when the device's member ids change; it answers the current status.
   */
  'env.watch': { params: { members: string[] }; result: EnvWatchState };
  /** Every set file in the working trees the agent knows (it learns them from the CLI). */
  'env.sets.list': { params: Record<string, never>; result: { sets: EnvSetSummary[] } };
  /**
   * One set file, its join request files, and for each line the short hash of the commit that
   * last changed it (git blame; index 0 is line 1; null when not committed). `not_found` when no
   * known set file at `path` has `setId`.
   */
  'env.file.read': {
    params: { path: string; setId: string };
    result: { file: string; fileHash: string; commits: (string | null)[]; requests: EnvJoinRequestEntry[] };
  };
  /**
   * Writes a change made on the device (a variable, a member, a new key) and removes the named
   * join request files, at once. `conflict` when the file no longer has `baseHash`. The agent
   * checks the file before writing and never commits.
   */
  'env.file.write': {
    params: { path: string; setId: string; baseHash: string; file?: string; removeRequests?: string[] };
    result: { fileHash: string };
  };
  /** Commits that touched the file, newest first. A page holds at most 64 commits and 768 KB; while `more`, ask again with `before` = the last hash. */
  'env.history.read': {
    params: { path: string; setId: string; before?: string };
    result: { commits: EnvCommit[]; more: boolean };
  };
  /** Answers a request. `not_found` when it was already answered elsewhere, ran out, or the command stopped. */
  'env.request.answer': { params: { requestId: string; answer: EnvAnswer }; result: Record<string, never> };
  /** End now on the device. */
  'env.grant.end': { params: { grantId: string }; result: Record<string, never> };
  /**
   * Own-device joins: the vault's check-code approval (vault/approval.ts), relayed between two
   * devices paired with this computer. In a challenge, `vault` and `vaultName` carry the set's id
   * and name, and the code is computed under the env join domain, so it never matches a vault
   * join's. Order, expiry (VAULT_JOIN_TTL_MS) and limits are as for vault.join.*.
   */
  'env.join.request': { params: { setId: string; request: VaultJoinRequest }; result: { requestId: string; expiresAt: number } };
  'env.join.challenge': { params: { requestId: string; challenge: VaultJoinChallenge }; result: Record<string, never> };
  'env.join.reveal': { params: { requestId: string; reveal: VaultJoinReveal }; result: Record<string, never> };
  /** Approver: approved after env.file.write added the new member, or not. */
  'env.join.finish': { params: { requestId: string; approved: boolean }; result: Record<string, never> };
  'env.join.cancel': { params: { requestId: string }; result: Record<string, never> };
}

export type EnvMethod = keyof EnvMethods;

export interface EnvRequest<M extends EnvMethod = EnvMethod> {
  id: string;
  method: M;
  params: EnvMethods[M]['params'];
}

export type EnvResponse<M extends EnvMethod = EnvMethod> =
  | { id: string; ok: true; result: EnvMethods[M]['result'] }
  | { id: string; ok: false; error: ProtocolError };

/** Events from the agent, only to sessions that called env.watch. */
export interface EnvEvents {
  /**
   * A computer asks. run, pull and push go to sessions holding a member of the set; create and
   * join-keys to every watching session (the person's own devices).
   */
  'env.request': { request: EnvComputerRequest };
  /** To the sessions that got the request: answered (by the named device), ran out, or the command stopped. */
  'env.request.closed': { requestId: string; reason: 'answered' | 'expired' | 'cancelled'; by?: string };
  /** The grants changed: the full list, and the one that ended, if one did. */
  'env.grants.changed': { grants: EnvGrant[]; ended?: { grantId: string; setId: string; reason: EnvGrantEndReason } };
  /** A set file or its join requests changed (setId), or the list of sets did (null). Read again. */
  'env.sets.changed': { setId: string | null };
  /** To watching sessions other than the new device's. */
  'env.join.requested': { requestId: string; setId: string; request: VaultJoinRequest; fromDevice: string; expiresAt: number };
  /** To the new device. */
  'env.join.challenged': { requestId: string; challenge: VaultJoinChallenge };
  /** To the approver. */
  'env.join.revealed': { requestId: string; reveal: VaultJoinReveal };
  /** To the new device. */
  'env.join.finished': { requestId: string; approved: boolean };
  'env.join.cancelled': { requestId: string; reason: 'cancelled' | 'expired' | 'disconnected' | 'taken' };
}

export type EnvEventName = keyof EnvEvents;

export interface EnvEventMessage<E extends EnvEventName = EnvEventName> {
  event: E;
  data: EnvEvents[E];
}
