/**
 * The socket methods (release, push, create, join, ls): what the `authdeck` command asks, checked,
 * turned into a request to devices (or answered inside a grant), and the answer carried out.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { AgentError, badRequest } from '../errors';
import {
  checkEnvPlainValues,
  envFileHash,
  envFileProblemWords,
  envJoinRequestPath,
  newEnvTransferKey,
  readEnvJoinRequest,
  writeEnvJoinRequest,
  type EnvVerifiedSet,
} from '../envcore';
import type { EnvFileProblem, EnvHeader, EnvRole } from '../envcore/types';
import type {
  EnvCommandError,
  EnvCreateResult,
  EnvJoinResult,
  EnvListResult,
  EnvListRow,
  EnvPushResult,
  EnvReleaseResult,
  EnvSocketMethod,
  EnvSocketMethods,
} from '../envSocketContract';
import type { EnvAnswer, EnvComputerRequest, EnvRequestBase, EnvRequestKind } from '../protocol';
import type { RateLimit } from '../rateLimit';
import { fromBase64Url, toBase64Url } from '../vault/bytes';
import { isUsableSealingKey } from '../vault/crypto';
import { activityOutcome, activityTitle, changeWords, plural, type ActivitySubject, type RequestEnd } from './activity';
import { displayRemote, gitTopLevel, GitUnavailable } from './git';
import * as read from './params';
import type { EnvPeer } from './peers';
import type { AnswerHandled, AskOutcome } from './relay';
import { Throttle } from './throttle';
import { acceptSetText, joinRequestFiles, problemCommit, requestFileSet, verifySetText } from './sets';
import { EnvCommandFailure, type SocketRequest } from './socketServer';
import type { EnvState } from './state';
import { FileExists, readSetFile, setFileLocation, WorkTreeError, writeRequestFile, writeSetFile, type SetFileLocation } from './workTree';

/** Every socket request, asked or not: each may run git and read files. */
export const ENV_SOCKET_RATE: RateLimit = { burst: 30, refillMs: 1_000 };
/** Requests that reach devices: each opens a sheet on every member's phone. */
export const ENV_ASK_RATE: RateLimit = { burst: 6, refillMs: 10_000 };
/** Requests waiting on devices at once. */
export const MAX_WAITING_ASKS = 4;

type Located = SetFileLocation & { remote: string | null };

function failure(error: EnvCommandError): EnvCommandFailure {
  return new EnvCommandFailure(error);
}

/** Over a limit: the command says how long to wait, in whole seconds, at least one. */
function rateLimited(retryAfterMs: number): EnvCommandFailure {
  return failure({ code: 'rate-limited', retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
}

/** The device's error when its answer was taken but the file had changed under it. */
function changedOnComputer(): AgentError {
  return new AgentError('conflict', 'The set file changed on the computer while you were answering.', 'Run the command on the computer again.');
}

function fileRefusedOnDevice(problem: EnvFileProblem, location: SetFileLocation): AgentError {
  const words = envFileProblemWords(problem, { file: location.relPath, set: location.setName, where: 'computer' });
  return badRequest(`The computer refused the file you sent: ${words.message}`);
}

/** A .env's values that break the rules, as the command words them. */
function valuesFailure(problem: EnvFileProblem, source: string): EnvCommandFailure {
  switch (problem.kind) {
    case 'bad-name':
      return failure({ code: 'bad-name', path: source, line: problem.line, name: problem.name });
    case 'too-large':
      if (problem.limit === 'names' || problem.limit === 'value' || problem.limit === 'values') return failure({ code: 'too-large', path: source, limit: problem.limit, name: problem.name ?? null });
      return failure({ code: 'failed', detail: `${source} is too large for a set.` });
    case 'duplicate-name':
      return failure({ code: 'failed', detail: `${source} lists ${problem.name} twice. Keep one, then try again.` });
    default:
      return failure({ code: 'failed', detail: `${source} can't be sent as it is.` });
  }
}

function sealingKey(text: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text);
  } catch {
    throw failure({ code: 'failed', detail: "The command's one-time key is malformed." });
  }
  if (!isUsableSealingKey(bytes)) throw failure({ code: 'failed', detail: "The command's one-time key is malformed." });
  return bytes;
}

/** Whether the header lists any of these member ids, and in which role. */
function roleOf(header: EnvHeader, ids: Set<string>): EnvRole | null {
  const mine = header.members.filter((member) => ids.has(member.id));
  if (mine.length === 0) return null;
  return mine.some((member) => member.role === 'owner') ? 'owner' : 'member';
}

type Release = { denied: string } | { result: EnvReleaseResult };
type Change<T> = { denied: string } | { changedBy: string } | { result: T };

export class EnvCommands {
  private readonly socketLimit: Throttle;
  private readonly askLimit: Throttle;

  constructor(private readonly state: EnvState) {
    this.socketLimit = new Throttle(ENV_SOCKET_RATE, state.now);
    this.askLimit = new Throttle(ENV_ASK_RATE, state.now);
  }

  readonly handle = async (request: SocketRequest): Promise<EnvSocketMethods[EnvSocketMethod]['result']> => {
    if (!this.socketLimit.tryTake()) throw rateLimited(this.socketLimit.retryAfterMs());
    switch (request.method) {
      case 'release':
        return this.release(request);
      case 'push':
        return this.push(request);
      case 'create':
        return this.create(request);
      case 'join':
        return this.join(request);
      case 'ls':
        return this.ls(request);
    }
  };

  // -------------------------------------------------------------------------
  // run and pull
  // -------------------------------------------------------------------------

  private async release(request: SocketRequest): Promise<EnvReleaseResult> {
    const p = request.params;
    const kind = p.kind;
    if (kind !== 'run' && kind !== 'pull') throw failure({ code: 'failed', detail: 'A release is a run or a pull.' });
    const project = read.project(p);
    const text = read.fileText(p);
    const command = read.argv(p);
    const cwd = read.stringField(p, 'cwd');
    const startedIn = read.nullableString(p, 'startedIn', 256);
    const target = read.target(p);
    const oneTimeKey = read.stringField(p, 'oneTimeKey', 64);
    const invocation = read.invocation(p);
    if (kind === 'run' && (command === null || target !== null)) throw failure({ code: 'failed', detail: 'A run needs a command and no target.' });
    if (kind === 'pull' && target === null) throw failure({ code: 'failed', detail: 'A pull needs a target file.' });
    const recipient = sealingKey(oneTimeKey);
    const location = await this.locate(project);
    const use = command ? command.join(' ') : invocation;
    const subject: ActivitySubject = { kind, setName: location.setName, detail: target ? target.path : use, notIgnored: target ? !target.gitignored : false };
    const set = await this.checkCommandFile(kind, location, text, subject);
    if (kind === 'run') subject.detail = `${use} · ${plural(set.live.length, 'variable')}`;
    const setId = set.file.header.set;

    const inGrant = this.releaseInGrant(location, set, recipient, use);
    if (inGrant) {
      this.state.registry.noteRelease(location.path, this.state.now());
      this.record(subject, { kind: 'inside-grant' });
      return inGrant;
    }

    const grantKey = newEnvTransferKey(this.state.random);
    let keptForGrant = false;
    const memberIds = new Set(set.file.header.members.map((member) => member.id));
    const envRequest: EnvComputerRequest = {
      ...this.base(location, setId, invocation),
      kind,
      setId,
      file: text,
      fileHash: set.fileHash,
      command,
      cwd,
      startedIn,
      target,
      oneTimeKey,
      grantKey: toBase64Url(grantKey.xPublic),
    };
    const { requestId } = envRequest;
    try {
      const outcome = await this.ask<Release>(request, envRequest, memberIds, (answer, peer) => {
        if (answer.kind === 'deny') return { value: { denied: peer.deviceName } };
        if (answer.kind !== 'release') throw badRequest("That answer doesn't fit a request for values.");
        const by = peer.deviceName;
        if (answer.scope === 'once') return { value: { result: { values: answer.values, by, via: 'once', grantEndsAt: null, source: answer.source, requestId } } };
        let opened;
        try {
          opened = this.state.grants.start(
            { setId, setName: location.setName, path: location.path, by, deviceId: peer.deviceId, fileHash: set.fileHash, source: answer.source, key: grantKey, sealed: answer.values, requestId },
            { recipient, use },
          );
        } catch {
          throw badRequest("The values sent for 15 minutes don't open with this request's grant key. Answer again.");
        }
        keptForGrant = true;
        return { value: { result: { values: opened.sealed, by, via: 'new-grant', grantEndsAt: opened.grant.endsAt, source: answer.source, requestId } } };
      });
      const value = this.answered(outcome, subject, memberIds);
      if ('denied' in value) {
        this.record(subject, { kind: 'denied', by: value.denied });
        throw failure({ code: 'denied', kind, set: location.setName, by: value.denied, command: command ? use : null, target: target ? target.path : null });
      }
      this.state.registry.noteRelease(location.path, this.state.now());
      this.record(subject, value.result.via === 'once' ? { kind: 'allowed-once', by: value.result.by } : { kind: 'new-grant', by: value.result.by });
      return value.result;
    } finally {
      if (!keptForGrant) grantKey.xSecret.fill(0);
    }
  }

  /** Inside an open grant for this set file: the values sealed to this run's key, under a new request id. */
  private releaseInGrant(location: Located, set: EnvVerifiedSet, recipient: Uint8Array, use: string): EnvReleaseResult | null {
    const { grants } = this.state;
    const grant = grants.find(location.path, set.file.header.set);
    if (!grant) return null;
    if (grant.fileHash !== set.fileHash) {
      grants.fileChanged(location.path, set.fileHash);
      return null;
    }
    const requestId = crypto.randomUUID();
    const values = grants.release(grant.grantId, { requestId, recipient, use });
    if (!values) return null;
    return { values, by: grant.by, via: 'grant', grantEndsAt: grant.endsAt, source: grant.source, requestId };
  }

  // -------------------------------------------------------------------------
  // push, create, join
  // -------------------------------------------------------------------------

  private async push(request: SocketRequest): Promise<EnvPushResult> {
    const p = request.params;
    const project = read.project(p);
    const text = read.fileText(p);
    const source = read.stringField(p, 'source');
    const values = read.plainValues(p);
    const prune = read.booleanField(p, 'prune');
    const invocation = read.invocation(p);
    const location = await this.locate(project);
    const problem = checkEnvPlainValues(values);
    if (problem) throw valuesFailure(problem, source);
    const subject: ActivitySubject = { kind: 'push', setName: location.setName, detail: source };
    const set = await this.checkCommandFile('push', location, text, subject);
    const setId = set.file.header.set;
    const memberIds = new Set(set.file.header.members.map((member) => member.id));
    const envRequest: EnvComputerRequest = { ...this.base(location, setId, invocation), kind: 'push', setId, file: text, fileHash: set.fileHash, source, values, prune };
    const outcome = await this.ask<Change<EnvPushResult>>(request, envRequest, memberIds, (answer, peer) => {
      if (answer.kind === 'deny') return { value: { denied: peer.deviceName } };
      if (answer.kind !== 'signed') throw badRequest("That answer doesn't fit a change.");
      const signed = verifySetText(this.state.registry, answer.file, location);
      if (!signed.ok) throw fileRefusedOnDevice(signed.problem, location);
      if (signed.set.file.header.set !== setId) throw badRequest('The signed file is for another set.');
      if (this.fileHashOnDisk(location) !== set.fileHash) return { value: { changedBy: peer.deviceName }, deviceError: changedOnComputer() };
      this.writeAccepted(location, answer.file, signed.set);
      subject.detail = changeWords(answer.added.length, answer.changed.length, answer.removed.length);
      return { value: { result: { by: peer.deviceName, fileHash: signed.set.fileHash, added: answer.added, changed: answer.changed, removed: answer.removed } } };
    });
    return this.changeResult(outcome, subject, memberIds, location, 'push');
  }

  private async create(request: SocketRequest): Promise<EnvCreateResult> {
    const p = request.params;
    const project = read.project(p);
    const setName = read.stringField(p, 'setName', 64);
    const source = read.nullableString(p, 'source');
    const values = read.plainValues(p);
    const invocation = read.invocation(p);
    const location = await this.locate(project);
    if (location.setName !== setName) throw failure({ code: 'failed', detail: `${project.path} isn't where a set named ${setName} goes.` });
    if (this.fileHashOnDisk(location) !== null) throw failure({ code: 'failed', detail: `${location.relPath} already exists. Run authdeck env init again to ask to join it.` });
    const problem = checkEnvPlainValues(values);
    if (problem) throw valuesFailure(problem, source ?? '.env');
    const subject: ActivitySubject = { kind: 'create', setName, detail: plural(values.length, 'variable') };
    const envRequest: EnvComputerRequest = { ...this.base(location, null, invocation), kind: 'create', setId: null, source, values };
    const outcome = await this.ask<Change<EnvCreateResult>>(request, envRequest, null, (answer, peer) => {
      if (answer.kind === 'deny') return { value: { denied: peer.deviceName } };
      if (answer.kind !== 'created') throw badRequest("That answer doesn't fit a new set.");
      const created = verifySetText(this.state.registry, answer.file, location);
      if (!created.ok) throw fileRefusedOnDevice(created.problem, location);
      try {
        writeSetFile(location, answer.file, { exclusive: true });
      } catch (err) {
        if (err instanceof FileExists) return { value: { changedBy: peer.deviceName }, deviceError: changedOnComputer() };
        throw err;
      }
      this.state.registry.accept(created.set);
      this.learn(location, created.set);
      const { header } = created.set.file;
      return {
        value: { result: { setId: header.set, by: peer.deviceName, fileHash: created.set.fileHash, variables: created.set.live.length, recovery: header.recovery !== null } },
      };
    });
    return this.changeResult(outcome, subject, null, location, 'create');
  }

  private async join(request: SocketRequest): Promise<EnvJoinResult> {
    const p = request.params;
    const project = read.project(p);
    const text = read.fileText(p);
    const invocation = read.invocation(p);
    const location = await this.locate(project);
    const subject: ActivitySubject = { kind: 'join-keys', setName: location.setName, detail: location.relPath };
    const set = await this.checkCommandFile('join-keys', location, text, subject);
    const setId = set.file.header.set;
    const envRequest: EnvComputerRequest = { ...this.base(location, setId, invocation), kind: 'join-keys', setId, file: text, fileHash: set.fileHash };
    const outcome = await this.ask<Change<EnvJoinResult>>(request, envRequest, null, (answer, peer) => {
      if (answer.kind === 'deny') return { value: { denied: peer.deviceName } };
      if (answer.kind !== 'join-keys') throw badRequest("That answer doesn't fit a request for join keys.");
      let requestText: string;
      let requestPath: string;
      try {
        requestText = writeEnvJoinRequest(answer.request);
        requestPath = envJoinRequestPath(answer.request.member);
      } catch {
        throw badRequest('The join request is malformed.');
      }
      const checked = readEnvJoinRequest(requestText, { set: setId, path: requestPath });
      if (!checked.ok) throw badRequest(`The computer refused the join request: ${checked.reason}.`);
      writeRequestFile(location.repoRoot, requestPath, requestText);
      this.state.setsChanged(setId);
      subject.detail = requestPath;
      return { value: { result: { by: peer.deviceName, requestPath, request: checked.request } } };
    });
    return this.changeResult(outcome, subject, null, location, 'join-keys');
  }

  // -------------------------------------------------------------------------
  // ls
  // -------------------------------------------------------------------------

  private async ls(request: SocketRequest): Promise<EnvListResult> {
    const p = request.params;
    const repoRoot = read.stringField(p, 'repoRoot');
    const remote = read.nullableString(p, 'remote');
    const files = read.listFiles(p);
    await this.requireRepo(repoRoot);
    const declared = new Set([...this.state.declared.values()].flatMap((device) => device.members));
    const sets: EnvListRow[] = files.map((entry) => {
      const location = setFileLocation(repoRoot, entry.path);
      if (!location) throw failure({ code: 'failed', detail: `${entry.path} isn't a set file in ${repoRoot}.` });
      const checked = acceptSetText(this.state.registry, entry.file, location);
      if (!checked.ok) {
        return { name: location.setName, setId: checked.setId, path: location.path, variables: 0, members: 0, yourRole: null, grantEndsAt: null, problem: checked.problem };
      }
      this.learn({ ...location, remote }, checked.set);
      const { header } = checked.set.file;
      return {
        name: header.name,
        setId: header.set,
        path: location.path,
        variables: checked.set.live.length,
        members: header.members.length,
        yourRole: roleOf(header, declared),
        grantEndsAt: this.state.grants.find(location.path, header.set)?.endsAt ?? null,
        problem: null,
      };
    });
    return { sets, joinRequests: await this.joinRequestsIn(repoRoot, sets) };
  }

  /** Request files in the tree that check out against a set listed here. */
  private async joinRequestsIn(repoRoot: string, sets: EnvListRow[]): Promise<EnvListResult['joinRequests']> {
    const listed = sets.filter((row) => row.problem === null && row.setId !== null);
    const files = await joinRequestFiles(repoRoot, new Set(listed.map((row) => row.setId!)));
    return files.flatMap((file) => {
      const set = listed.find((row) => row.setId === requestFileSet(file));
      const checked = set ? readEnvJoinRequest(file.text, { set: set.setId!, path: file.relPath }) : null;
      return set && checked?.ok ? [{ setName: set.name, label: checked.request.label }] : [];
    });
  }

  // -------------------------------------------------------------------------
  // Shared steps
  // -------------------------------------------------------------------------

  /** The set file the command named: a set file path inside a git working tree's top folder. */
  private async locate(project: { repoRoot: string; remote: string | null; path: string }): Promise<Located> {
    const location = setFileLocation(project.repoRoot, project.path);
    if (!location) throw failure({ code: 'failed', detail: `${project.path} isn't a set file in ${project.repoRoot}/.authdeck.` });
    await this.requireRepo(location.repoRoot);
    return { ...location, remote: project.remote };
  }

  private async requireRepo(repoRoot: string): Promise<void> {
    let top: string | null;
    try {
      top = await gitTopLevel(repoRoot);
    } catch (err) {
      if (err instanceof GitUnavailable) throw failure({ code: 'failed', detail: err.message });
      // The folder isn't there, or isn't a folder.
      throw failure({ code: 'no-repo', folder: repoRoot });
    }
    if (top === null || realPath(top) !== realPath(repoRoot)) throw failure({ code: 'no-repo', folder: repoRoot });
  }

  /** Checks the file the command read against what this computer accepted; refuses it with the commit that brought the problem in. */
  private async checkCommandFile(kind: EnvRequestKind, location: Located, text: string, subject: ActivitySubject): Promise<EnvVerifiedSet> {
    const checked = acceptSetText(this.state.registry, text, location);
    if (!checked.ok) {
      this.record(subject, { kind: 'file-refused' });
      const commit = await problemCommit(location, checked.problem, text);
      throw failure({ code: 'file-refused', kind, set: location.setName, file: location.relPath, problem: checked.problem, commit });
    }
    this.learn(location, checked.set);
    return checked.set;
  }

  private learn(location: SetFileLocation & { remote: string | null }, set: EnvVerifiedSet): void {
    const { header } = set.file;
    const entry = { path: location.path, repoRoot: location.repoRoot, remote: displayRemote(location.remote), setId: header.set, name: header.name };
    if (this.state.registry.learn(entry, this.state.now())) this.state.setsChanged(null);
  }

  private base(location: Located, setId: string | null, invocation: string): EnvRequestBase {
    const askedAt = this.state.now();
    return {
      requestId: crypto.randomUUID(),
      setId,
      setName: location.setName,
      path: location.path,
      repoRoot: location.repoRoot,
      remote: displayRemote(location.remote),
      invocation,
      askedAt,
      expiresAt: askedAt + this.state.requestTtlMs,
    };
  }

  /** Sends a request to member sessions (or, with null, to every watching session) and waits. */
  private ask<T>(request: SocketRequest, envRequest: EnvComputerRequest, memberIds: Set<string> | null, handle: (answer: EnvAnswer, peer: EnvPeer) => AnswerHandled<T>): Promise<AskOutcome<T>> {
    const { relay } = this.state;
    if (relay.count() >= MAX_WAITING_ASKS) throw rateLimited((relay.soonestExpiry() ?? this.state.now()) - this.state.now());
    if (!this.askLimit.tryTake()) throw rateLimited(this.askLimit.retryAfterMs());
    return relay.ask<T>({
      request: envRequest,
      routesTo: (peer) => memberIds === null || peer.members.some((member) => memberIds.has(member)),
      handle,
      onDevices: (devices) => request.progress({ stage: 'asking', devices, expiresAt: envRequest.expiresAt }),
      signal: request.signal,
    });
  }

  /** The answer's value; an expired or cancelled request ends the command here. */
  private answered<T>(outcome: AskOutcome<T>, subject: ActivitySubject, memberIds: Set<string> | null): T {
    if (outcome.outcome === 'answered') return outcome.value;
    if (outcome.outcome === 'cancelled') {
      this.record(subject, { kind: 'cancelled' });
      // The command is gone; nothing reads this.
      throw failure({ code: 'failed', detail: 'Cancelled.' });
    }
    this.record(subject, { kind: 'no-answer' });
    throw failure({ code: 'no-answer', set: subject.setName, devices: this.memberDevices(memberIds), waitedSec: Math.round(this.state.requestTtlMs / 1000) });
  }

  private changeResult<T>(outcome: AskOutcome<Change<T>>, subject: ActivitySubject, memberIds: Set<string> | null, location: SetFileLocation, kind: 'push' | 'create' | 'join-keys'): T {
    const value = this.answered(outcome, subject, memberIds);
    if ('denied' in value) {
      this.record(subject, { kind: 'denied', by: value.denied });
      throw failure({ code: 'denied', kind, set: location.setName, by: value.denied, command: null, target: null });
    }
    if ('changedBy' in value) {
      this.record(subject, { kind: 'changed-meanwhile' });
      throw failure({ code: 'changed-meanwhile', file: location.relPath, by: value.changedBy });
    }
    const by = (value.result as { by: string }).by;
    this.record(subject, kind === 'push' ? { kind: 'signed', by } : kind === 'create' ? { kind: 'created', by } : { kind: 'keys-made', by });
    return value.result;
  }

  /** Paired devices that declared a member of the set (any, for a set not made yet), by name. */
  private memberDevices(memberIds: Set<string> | null): string[] {
    const names = [...this.state.declared.values()].filter((device) => memberIds === null || device.members.some((member) => memberIds.has(member))).map((device) => device.deviceName);
    return [...new Set(names)];
  }

  /** The hash of the set file on disk now; null when it isn't there (or can't be read as one). */
  private fileHashOnDisk(location: SetFileLocation): string | null {
    try {
      const text = readSetFile(location);
      return text === null ? null : envFileHash(text);
    } catch (err) {
      if (err instanceof WorkTreeError) return null;
      throw err;
    }
  }

  private writeAccepted(location: SetFileLocation, text: string, set: EnvVerifiedSet): void {
    writeSetFile(location, text);
    this.state.registry.accept(set);
    this.state.grants.fileChanged(location.path, set.fileHash);
    this.state.setsChanged(set.file.header.set);
  }

  private record(subject: ActivitySubject, end: RequestEnd): void {
    const title = activityTitle(subject, end);
    const outcome = activityOutcome(subject, end);
    this.state.activity({ kind: subject.kind, setName: subject.setName, title, detail: subject.detail, outcome });
    this.state.log(`env: ${title} (${subject.detail}): ${outcome.text}`);
  }
}

function realPath(folder: string): string | null {
  try {
    return fs.realpathSync(folder);
  } catch {
    return null;
  }
}
