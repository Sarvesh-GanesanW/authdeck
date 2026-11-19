/**
 * The env.* methods a device calls over the link: watching, reading and writing set files in the
 * working trees the agent knows, their git history, answering requests, ending grants, and the
 * own-device join relay. Errors are AgentErrors, answered to the device as protocol errors.
 */
import { AgentError, badRequest, rateLimited } from '../errors';
import { envFileHash, envFileProblemWords } from '../envcore';
import { ENV_LIMITS } from '../envcore/types';
import type { EnvJoinRequestEntry, EnvMethod, EnvMethods } from '../protocol';
import { mapLimit } from '../proc';
import { RateLimiter, type RateLimit } from '../rateLimit';
import { isId } from '../vault/entry';
import { blameLines, COMMIT_HASH_PATTERN, commitThatAdded, fileHistory, HistoryUnreadable } from './git';
import type { EnvPeer } from './peers';
import type { KnownSetFile } from './registry';
import { joinRequestFiles, lineCount, summarize, verifySetText } from './sets';
import type { EnvState } from './state';
import { isRequestPath, readSetFile, removeRequestFile, setFileLocation, WorkTreeError, writeSetFile, type SetFileLocation } from './workTree';

/** Per paired device: reads run git and read working trees. */
export const ENV_READ_RATE: RateLimit = { burst: 60, refillMs: 500 };
/** Per paired device: each write rewrites a set file. */
export const ENV_WRITE_RATE: RateLimit = { burst: 30, refillMs: 500 };
export const HISTORY_PAGE = { commits: 64, bytes: 768 * 1024, fileBytes: ENV_LIMITS.fileBytes } as const;
const MAX_REMOVED_REQUESTS = 64;
const SUMMARY_CONCURRENCY = 4;

type Params = Record<string, unknown>;

interface DeviceLimits {
  read: RateLimiter;
  write: RateLimiter;
}

function notFound(): AgentError {
  return new AgentError('not_found', "That set file isn't on this computer any more.", 'Run an authdeck env command in the project folder, then try again.');
}

function setRef(params: Params): { path: string; setId: string } {
  if (typeof params.path !== 'string' || params.path.length > 4096) throw badRequest('The set file path is missing.');
  if (!isId(params.setId)) throw badRequest('The set id is missing or malformed.');
  return { path: params.path, setId: params.setId };
}

export class EnvDeviceMethods {
  private readonly limits = new Map<string, DeviceLimits>();

  constructor(private readonly state: EnvState) {}

  /** Handles one env.* method; anything else is refused as unknown. */
  handle(peer: EnvPeer, method: string, params: Params): Promise<unknown> | unknown {
    switch (method as EnvMethod) {
      case 'env.watch':
        return this.watch(peer, params);
      case 'env.sets.list':
        this.take(peer, 'read');
        return this.listSets();
      case 'env.file.read':
        this.take(peer, 'read');
        return this.readFile(params);
      case 'env.file.write':
        this.take(peer, 'write');
        return this.writeFile(params);
      case 'env.history.read':
        this.take(peer, 'read');
        return this.history(params);
      case 'env.request.answer':
        return this.state.relay.answer(peer, params.requestId, params.answer);
      case 'env.grant.end':
        return this.endGrant(params);
      case 'env.join.request':
        return this.state.joins.request(peer.deviceId, params);
      case 'env.join.challenge':
        return this.state.joins.challenge(peer.deviceId, params);
      case 'env.join.reveal':
        return this.state.joins.reveal(peer.deviceId, params);
      case 'env.join.finish':
        return this.state.joins.finish(peer.deviceId, params);
      case 'env.join.cancel':
        return this.state.joins.cancel(peer.deviceId, params);
      default:
        throw badRequest(`"${method}" is not a method this agent knows. Update the AuthDeck agent on the computer.`);
    }
  }

  private watch(peer: EnvPeer, params: Params): EnvMethods['env.watch']['result'] {
    const members = params.members;
    if (!Array.isArray(members) || members.length > ENV_LIMITS.members * 4 || !members.every(isId)) throw badRequest('"members" must be a list of member ids.');
    peer.members = [...new Set(members as string[])];
    this.state.declared.set(peer.deviceId, { deviceName: peer.deviceName, members: peer.members });
    return { requests: this.state.relay.watched(peer), grants: this.state.grants.list() };
  }

  private async listSets(): Promise<EnvMethods['env.sets.list']['result']> {
    const known = [...this.state.registry.files()];
    const summaries = await mapLimit(known, SUMMARY_CONCURRENCY, (file) => summarize(this.state.registry, file));
    return { sets: summaries.filter((summary) => summary !== null) };
  }

  private async readFile(params: Params): Promise<EnvMethods['env.file.read']['result']> {
    const { location } = this.known(params);
    const text = this.readOrNotFound(location);
    const requests = await joinRequestFiles(location.repoRoot, new Set([params.setId as string]));
    const [commits, added] = await Promise.all([
      blameLines(location.repoRoot, location.relPath, lineCount(text)),
      Promise.all(requests.map((request) => commitThatAdded(location.repoRoot, request.relPath))),
    ]);
    const entries: EnvJoinRequestEntry[] = requests.map((request, index) => ({ path: request.relPath, text: request.text, commit: added[index] ?? null }));
    return { file: text, fileHash: envFileHash(text), commits, requests: entries };
  }

  /**
   * Writes a device's change and removes the named request files, after checking the file is still
   * what the device read (`conflict`) and that its change passes every check against what this
   * computer accepted. The agent never commits.
   */
  private writeFile(params: Params): EnvMethods['env.file.write']['result'] {
    const { location, setId } = this.known(params);
    if (typeof params.baseHash !== 'string') throw badRequest('"baseHash" is missing.');
    const removals = params.removeRequests ?? [];
    if (!Array.isArray(removals) || removals.length > MAX_REMOVED_REQUESTS || !removals.every(isRequestPath)) throw badRequest('"removeRequests" must list join request files.');
    const current = this.readOrNotFound(location);
    if (envFileHash(current) !== params.baseHash) throw new AgentError('conflict', 'The set file changed since this device read it.', 'Read it again and redo the change.');
    let fileHash = params.baseHash;
    if (params.file !== undefined) {
      if (typeof params.file !== 'string') throw badRequest('"file" must be the whole set file.');
      const checked = verifySetText(this.state.registry, params.file, location);
      if (!checked.ok) {
        const words = envFileProblemWords(checked.problem, { file: location.relPath, set: location.setName, where: 'computer' });
        throw badRequest(`The computer refused the file, so nothing was written: ${words.message}`);
      }
      if (checked.set.file.header.set !== setId) throw badRequest('The file is for another set.');
      writeSetFile(location, params.file);
      this.state.registry.accept(checked.set);
      fileHash = checked.set.fileHash;
      this.state.grants.fileChanged(location.path, fileHash);
    }
    for (const relPath of removals as string[]) removeRequestFile(location.repoRoot, relPath);
    if (params.file !== undefined || removals.length > 0) this.state.setsChanged(setId);
    return { fileHash };
  }

  private async history(params: Params): Promise<EnvMethods['env.history.read']['result']> {
    const { location } = this.known(params);
    const before = params.before;
    if (before !== undefined && (typeof before !== 'string' || !COMMIT_HASH_PATTERN.test(before))) throw badRequest('"before" must be a full commit hash.');
    try {
      return await fileHistory(location.repoRoot, location.relPath, (before as string | undefined) ?? null, HISTORY_PAGE);
    } catch (err) {
      if (err instanceof HistoryUnreadable) throw new AgentError('failed', err.message);
      throw err;
    }
  }

  private endGrant(params: Params): Record<string, never> {
    if (typeof params.grantId !== 'string' || !this.state.grants.end(params.grantId, 'ended-on-device')) {
      throw new AgentError('not_found', 'That grant has already ended.');
    }
    return {};
  }

  /** A set file the agent knows at `path` with `setId`; not_found otherwise. */
  private known(params: Params): { location: SetFileLocation; setId: string; file: KnownSetFile } {
    const { path, setId } = setRef(params);
    const file = this.state.registry.find(path, setId);
    const location = file ? setFileLocation(file.repoRoot, file.path) : null;
    if (!file || !location) throw notFound();
    return { location, setId, file };
  }

  private readOrNotFound(location: SetFileLocation): string {
    let text: string | null;
    try {
      text = readSetFile(location);
    } catch (err) {
      if (err instanceof WorkTreeError) throw new AgentError('failed', err.message);
      throw err;
    }
    if (text === null) throw notFound();
    return text;
  }

  private take(peer: EnvPeer, kind: keyof DeviceLimits): void {
    let limits = this.limits.get(peer.deviceId);
    if (!limits) {
      limits = { read: new RateLimiter(ENV_READ_RATE, this.state.now), write: new RateLimiter(ENV_WRITE_RATE, this.state.now) };
      this.limits.set(peer.deviceId, limits);
    }
    if (!limits[kind].tryTake()) throw rateLimited(`This device is ${kind === 'read' ? 'reading' : 'changing'} env sets too fast. Wait a moment and try again.`);
  }
}
