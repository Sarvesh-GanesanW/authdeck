/**
 * Keeps one live session with the active computer: connects, re-authenticates,
 * reconnects with backoff, finds the computer again if its address changed,
 * and exposes the calls screens need (apps, icons, folders, run).
 */
import { AppState } from 'react-native';

import {
  type Action,
  type AgentInfo,
  type AppEntry,
  type AppIcon,
  type EventMessage,
  type FocusInfo,
  type FsListResult,
  type Method,
  type Methods,
  PROTOCOL_VERSION,
} from '../protocol';
import { formatDuration, runTimeoutMs } from '../lib/describe';
import { haptics } from '../lib/haptics';
import { type CommandOutput, useLive } from '../state/live';
import type { Computer, DeckKey, Page } from '../state/model';
import { entryFor, needsRepair, useStore, withTwoFaPage } from '../state/store';
import { starterDeck } from '../state/templates';
import { showUnpaired } from '../state/ui';
import { linkFingerprint, parseLinkPublicKey } from '../link/keys';
import { AgentSession, RequestError, openSession } from './client';
import { fetchHello, findAgent, isAllowedHost } from './discovery';
import { deviceLinkKey } from './linkIdentity';
import { connectCanary } from '../state/connectCanary';
import { iconCanary } from '../state/iconCanary';
import { readIconCache, removeIconCache, writeIconCache } from './iconCacheStorage';
import { IconMemory } from './iconMemory';
import { checkedIconCache } from './storedData';
import { acceptedIdentity } from './trust';

const BACKOFF = [500, 1000, 2000, 4000, 8000];
const PING_EVERY = 10000;
/**
 * Back in the foreground with a session that looks open: a ping this short proves it still is. A
 * phone asleep while the computer unpaired it may not have seen the connection end.
 */
const WAKE_PING_MS = 3000;
/**
 * The most one computer's saved icons may take, in characters of JSON (icons are ASCII base64).
 * Icons are saved under a key per computer, apart from the main state, and keys' icons past this
 * are not saved: they load from the computer instead.
 */
export const MAX_ICON_CACHE_CHARS = 1_000_000;
const ICONS_PER_CALL = 48;
/** After the computer sent something unreadable, wait the longest backoff before trying again. */
const AFTER_MALFORMED_MS = BACKOFF[BACKOFF.length - 1]!;
/**
 * A session that stays open this long counts as a working connection and resets the backoff. One
 * the computer closes sooner (a computer that accepts and hangs up) keeps backing off.
 */
export const STABLE_SESSION_MS = 10000;
const HELLO_TIMEOUT_MS = 1500;
/** Focus redraws at most this often; the latest focus is drawn at the end of each interval. */
export const FOCUS_REDRAW_MS = 250;

/** Finds a computer whose address changed; see discovery.ts. Passed in so tests can stand in. */
export type FindComputer = typeof findAgent;
/** Reads an address's unauthenticated /hello; see discovery.ts. Passed in so tests can stand in. */
export type ReadHello = typeof fetchHello;

/** How one address went: only failures carry the address and the error, for the version check. */
type HostOutcome = { kind: 'online' } | { kind: 'unauthorized' } | { kind: 'failed'; host: string; error: unknown };

const isVersionRefusal = (error: unknown): error is RequestError => error instanceof RequestError && error.code === 'version';

/** The app's words when a computer answers under its saved key with another id. */
const OTHER_ID = {
  message: 'The computer at this address gave another id than the one saved for it.',
  hint: 'AuthDeck keeps trying its other addresses. If AuthDeck Agent was reinstalled on it, pair again.',
};

/** An app list request waiting for the one in flight: later asks join it. */
interface QueuedAppList {
  refresh: boolean;
  done: Promise<void>;
}

export class ConnectionManager {
  constructor(
    private readonly findComputer: FindComputer = findAgent,
    private readonly readHello: ReadHello = fetchHello,
  ) {}

  private computer: Computer | null = null;
  private session: AgentSession | null = null;
  private generation = 0;
  /** The generation whose connection attempt is under way, if one is. */
  private attemptGen: number | null = null;
  /** Stops this generation's searches for a moved computer (a shared sweep) when the generation changes. */
  private search = new AbortController();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  /** This computer's refusal already opened the pairing screen; not again until it connects. */
  private refusalShown = false;
  /** When the current session opened; its length on close decides whether the backoff resets. */
  private sessionOpenedAt = 0;
  /** Icon ids asked of the current computer and not answered yet; a new set per computer switch. */
  private iconsInFlight = new Set<string>();
  private readonly iconMemory = new IconMemory();
  private iconSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private eventListeners = new Set<(msg: EventMessage) => void>();
  /** The app and the agent speak different versions; said once per computer switch, not per retry. */
  private versionToastShown = false;
  /** At most one apps.list in flight, and at most one waiting behind it (apps.changed is coalesced). */
  private appListInFlight: Promise<void> | null = null;
  private appListQueued: QueuedAppList | null = null;
  /** The newest focus not drawn yet, and the timer that draws it. */
  private pendingFocus: FocusInfo | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  init(): () => void {
    let lastActive = useStore.getState().activeId;
    const unsubStore = useStore.subscribe((s) => {
      if (s.activeId !== lastActive) {
        lastActive = s.activeId;
        this.switchTo(s.computers.find((c) => c.agentId === s.activeId) ?? null);
      }
    });
    const sub = AppState.addEventListener('change', (state) => {
      // Away from the foreground (iOS's app switcher is 'inactive'), a swipe or the system may end
      // AuthDeck at any moment; that is not closing while connecting, so the mark stops naming them.
      connectCanary.setForeground(state === 'active');
      if (state === 'active') this.wake();
    });
    const s = useStore.getState();
    this.switchTo(s.computers.find((c) => c.agentId === s.activeId) ?? null);
    return () => {
      unsubStore();
      sub.remove();
      this.switchTo(null);
    };
  }

  /** Reconnect now (app came to the foreground, or the user asked). */
  wake(): void {
    if (!this.computer) return;
    const st = useLive.getState().status;
    const session = this.session;
    if (st === 'online' && session?.isOpen) {
      session.request('ping', {}, WAKE_PING_MS).catch(() => session.close());
      return;
    }
    this.attempt = 0;
    this.connectLoop(this.generation);
  }

  /** Call after re-pairing a computer that refused this device. */
  restart(): void {
    const s = useStore.getState();
    this.switchTo(s.computers.find((c) => c.agentId === s.activeId) ?? null);
  }

  private switchTo(computer: Computer | null): void {
    this.generation++;
    this.search.abort();
    this.search = new AbortController();
    this.clearTimers();
    this.iconsInFlight = new Set();
    this.iconMemory.reset();
    this.session?.close();
    this.session = null;
    this.computer = computer;
    this.attempt = 0;
    this.versionToastShown = false;
    this.refusalShown = false;
    useLive.setState({
      status: computer ? 'connecting' : 'idle',
      agent: null,
      host: null,
      focus: null,
      apps: null,
      appsError: null,
      icons: {},
      keyStates: {},
    });
    if (!computer) return;
    void this.loadIconCache(computer.agentId);
    this.connectLoop(this.generation);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.focusTimer) clearTimeout(this.focusTimer);
    if (this.iconSaveTimer) clearTimeout(this.iconSaveTimer);
    this.iconSaveTimer = null;
    this.retryTimer = null;
    this.pingTimer = null;
    this.focusTimer = null;
    this.pendingFocus = null;
    this.appListInFlight = null;
    this.appListQueued = null;
  }

  /** Draws focus changes at most every FOCUS_REDRAW_MS, always ending on the newest. */
  private showFocus(focus: FocusInfo): void {
    this.pendingFocus = focus;
    if (this.focusTimer) return;
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      const latest = this.pendingFocus;
      this.pendingFocus = null;
      if (latest) useLive.setState({ focus: latest });
    }, FOCUS_REDRAW_MS);
  }

  /**
   * One connection attempt at a time per generation. At a cold start, init's first attempt and the
   * app becoming active (wake) both start one; without this, both connected and two sessions
   * stayed open.
   */
  private async connectLoop(gen: number): Promise<void> {
    if (this.attemptGen === gen) return;
    this.attemptGen = gen;
    try {
      await this.connectOnce(gen);
    } finally {
      if (this.attemptGen === gen) this.attemptGen = null;
    }
  }

  private async connectOnce(gen: number): Promise<void> {
    const computer = this.computer;
    if (!computer || gen !== this.generation) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const live = useLive.getState();
    if (live.status !== 'online') live.setStatus(this.attempt === 0 ? 'connecting' : 'offline');

    const fresh = useStore.getState().computers.find((c) => c.agentId === computer.agentId) ?? computer;
    // Paired before the connection was encrypted: nothing to connect with until it pairs again.
    if (needsRepair(fresh)) {
      live.setStatus('unauthorized');
      return;
    }
    // AuthDeck closed while connecting to some of its addresses (state/connectCanary.ts): those are
    // skipped, and the others tried. Only when every address is held does the computer stay offline
    // until the person chooses Connect on the notice, which wakes this loop.
    await connectCanary.check();
    if (gen !== this.generation) return;
    if (this.isHeld(fresh)) {
      useLive.getState().setStatus('offline');
      return;
    }
    const failures: { host: string; error: unknown }[] = [];
    /** Tries each address in turn; true once one connects or refuses, or this loop is stale. */
    const tryEach = async (hosts: string[]): Promise<boolean> => {
      for (const host of hosts) {
        if (gen !== this.generation) return true;
        const outcome = await this.tryHost(gen, fresh, host);
        if (outcome.kind !== 'failed') return true;
        failures.push(outcome);
      }
      return gen !== this.generation;
    };
    if (await tryEach(fresh.hosts.filter((host) => !connectCanary.isHeld(host)))) return;

    // Every second failed round, look for the computer at a new address. Anything on the network
    // can answer discovery, so every address that answers is tried, and one is saved (by tryHost)
    // only once the handshake there proves it is this computer.
    this.attempt++;
    if (this.attempt % 2 === 0) {
      const found = await this.findComputer(fresh.agentId, fresh.port, linkFingerprint(parseLinkPublicKey(fresh.linkKey!)), this.search.signal);
      if (gen !== this.generation) return;
      if (await tryEach(found.filter((host) => !fresh.hosts.includes(host) && isAllowedHost(host) && !connectCanary.isHeld(host)))) return;
    }
    await this.reportVersionProblem(gen, fresh, failures);
    if (gen !== this.generation) return;
    useLive.getState().setStatus('offline');
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!;
    this.retryTimer = setTimeout(() => this.connectLoop(gen), delay);
  }

  /** Every saved address is held, so nothing is left to try until Connect. */
  private isHeld(computer: Computer): boolean {
    return computer.hosts.length > 0 && computer.hosts.every((host) => connectCanary.isHeld(host));
  }

  private async tryHost(gen: number, computer: Computer, host: string): Promise<HostOutcome> {
    let opened: { session: AgentSession; agent: AgentInfo };
    try {
      opened = await openSession(host, computer.port, await deviceLinkKey(), parseLinkPublicKey(computer.linkKey!));
    } catch (e) {
      // The computer itself refused this device, inside the encrypted handshake: stop and ask to
      // pair again. Any other failure, plain-text refusals included, may be another machine at
      // this address, so the loop moves on and keeps retrying.
      if (e instanceof RequestError && e.code === 'unauthorized' && e.fromComputer) {
        if (gen === this.generation) this.refused(computer);
        return { kind: 'unauthorized' };
      }
      return { kind: 'failed', host, error: e };
    }
    const { session, agent } = opened;
    try {
      if (gen !== this.generation) {
        session.close();
        return { kind: 'failed', host, error: null };
      }
      // The pinned key proves the computer's key, not that it is the saved entry: an id other than
      // the saved one is another computer holding that key, and never becomes this one.
      if (agent.agentId !== computer.agentId) {
        session.close();
        return { kind: 'failed', host, error: new RequestError('failed', OTHER_ID.message, OTHER_ID.hint) };
      }
      this.session = session;
      this.sessionOpenedAt = Date.now();
      session.onEvent = (msg) => {
        // The session checked each event's data against its shape before handing it over.
        if (msg.event === 'focus') this.showFocus((msg as EventMessage<'focus'>).data);
        if (msg.event === 'apps.changed') void this.listApps(false);
        this.eventListeners.forEach((listener) => listener(msg));
      };
      session.onClose = () => {
        if (gen !== this.generation || this.session !== session) return;
        this.session = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        useLive.getState().setStatus('offline');
        this.retryTimer = setTimeout(() => this.connectLoop(gen), this.delayAfterClose(session.failed !== null));
      };
      // Remember what worked; take the name the computer reports unless it reads like another saved computer's.
      const hosts = [host, ...computer.hosts.filter((h) => h !== host)].slice(0, 6);
      const { computers } = useStore.getState();
      const saved = computers.find((c) => c.agentId === computer.agentId) ?? computer;
      const identity = acceptedIdentity(saved, agent, computers);
      // Every store change is written to the device, so a reconnect that learned nothing writes nothing.
      if (!sameSavedDetails(saved, { hosts, ...identity })) useStore.getState().updateComputer(computer.agentId, { hosts, ...identity });
      useLive.setState({ status: 'online', agent: { ...agent, ...identity }, host });
      this.refusalShown = false;
      this.pingTimer = setInterval(() => {
        session.request('ping', {}, 5000).catch(() => session.close());
      }, PING_EVERY);
      void this.listApps(false);
      return { kind: 'online' };
    } catch (e) {
      session.close();
      return { kind: 'failed', host, error: e };
    }
  }

  /**
   * The computer refused this device inside the encrypted handshake: it was unpaired there. The
   * computer stays saved with its pages, marked as needing pairing again, and the pairing screen
   * opens for it once, so going back to the deck doesn't bring it straight back.
   */
  private refused(computer: Computer): void {
    useLive.getState().setStatus('unauthorized');
    if (this.refusalShown) return;
    this.refusalShown = true;
    showUnpaired(computer.agentId);
  }

  /**
   * How long to wait before reconnecting after the computer closed a session. Never immediate: a
   * computer that accepts and hangs up would otherwise be reconnected to in a tight loop. Only a
   * session that stayed up STABLE_SESSION_MS resets the backoff.
   */
  private delayAfterClose(malformed: boolean): number {
    // A computer that sends unreadable messages waits the longest backoff every time.
    if (malformed) return AFTER_MALFORMED_MS;
    const lasted = Date.now() - this.sessionOpenedAt;
    this.attempt = lasted >= STABLE_SESSION_MS ? 0 : this.attempt + 1;
    return BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!;
  }

  /**
   * After a whole round failed, says the computer runs a different version, but only on evidence
   * no other machine on the network can fake. A plain-text "version" code alone could come from
   * anything at the address, so it never shows the message by itself.
   */
  private async reportVersionProblem(gen: number, computer: Computer, failures: { host: string; error: unknown }[]): Promise<void> {
    if (this.versionToastShown) return;
    const refusal = await this.provenVersionRefusal(computer, failures);
    if (!refusal || gen !== this.generation || this.versionToastShown) return;
    this.versionToastShown = true;
    useLive.getState().showToast({ tone: 'fail', title: refusal.message, detail: refusal.hint });
  }

  /**
   * The computer's own refusal inside the encrypted handshake, or else a plain-text one from an
   * address whose /hello names this computer (id and key fingerprint) at another protocol version.
   */
  private async provenVersionRefusal(computer: Computer, failures: { host: string; error: unknown }[]): Promise<RequestError | null> {
    const refusals = failures.filter((f): f is { host: string; error: RequestError } => isVersionRefusal(f.error));
    const encrypted = refusals.find((f) => f.error.fromComputer);
    if (encrypted) return encrypted.error;
    const fingerprint = linkFingerprint(parseLinkPublicKey(computer.linkKey!));
    for (const { host, error } of refusals) {
      const hello = await this.readHello(host, computer.port, HELLO_TIMEOUT_MS);
      if (hello?.agentId === computer.agentId && hello.fingerprint === fingerprint && hello.protocol !== PROTOCOL_VERSION) return error;
    }
    return null;
  }

  private requireSession(): AgentSession {
    if (!this.session?.isOpen) {
      const name = this.computer?.name ?? 'The computer';
      throw new RequestError('offline', `${name} is offline. AuthDeck is reconnecting.`);
    }
    return this.session;
  }

  /**
   * Reads the computer's app list. One request at a time: a call while one is in flight waits for
   * it and then runs once for every call that waited (a refresh if any of them asked for one), so
   * a computer sending apps.changed in a burst gets at most two requests.
   */
  listApps(refresh: boolean): Promise<void> {
    if (!this.appListInFlight) return this.startAppList(refresh);
    if (this.appListQueued) {
      this.appListQueued.refresh ||= refresh;
      return this.appListQueued.done;
    }
    const gen = this.generation;
    const queued: QueuedAppList = { refresh, done: Promise.resolve() };
    queued.done = this.appListInFlight.then(() => {
      if (this.appListQueued === queued) this.appListQueued = null;
      return gen === this.generation ? this.startAppList(queued.refresh) : undefined;
    });
    this.appListQueued = queued;
    return queued.done;
  }

  private startAppList(refresh: boolean): Promise<void> {
    const request = this.fetchAppList(this.generation, refresh).finally(() => {
      if (this.appListInFlight === request) this.appListInFlight = null;
    });
    this.appListInFlight = request;
    return request;
  }

  private async fetchAppList(gen: number, refresh: boolean): Promise<void> {
    try {
      const { apps } = await this.requireSession().request('apps.list', { refresh }, refresh ? 60000 : 30000);
      if (gen !== this.generation) return;
      useLive.setState({ apps, appsError: null });
      this.seedDeck(apps);
    } catch (e) {
      if (gen !== this.generation) return;
      useLive.setState({ appsError: e instanceof Error ? e.message : 'Could not read the app list.' });
      this.seedDeck([]);
    }
  }

  /** A newly paired computer gets the starter deck, built from the apps it has. */
  private seedDeck(apps: AppEntry[]): void {
    const c = this.computer;
    const agent = useLive.getState().agent;
    if (!c || !agent) return;
    if (entryFor(useStore.getState().decks, c.agentId)) return;
    useStore.getState().setDeck(c.agentId, withTwoFaPage(starterDeck(agent.platform, apps)));
  }

  /**
   * Fetches icons not in memory. Safe to call repeatedly from renders: an id already asked for is
   * not asked again until its answer arrives. Answers from a computer the app has since switched
   * away from (or reconnected to) are dropped.
   */
  async loadIcons(ids: string[]): Promise<void> {
    const have = useLive.getState().icons;
    const inFlight = this.iconsInFlight;
    const need = [...new Set(ids)].filter((id) => !Object.prototype.hasOwnProperty.call(have, id) && !inFlight.has(id));
    const session = this.session;
    const computer = this.computer;
    if (need.length === 0 || !session?.isOpen || !computer) return;
    const generation = this.generation;
    need.forEach((id) => inFlight.add(id));
    try {
      for (let i = 0; i < need.length; i += ICONS_PER_CALL) {
        const batch = need.slice(i, i + ICONS_PER_CALL);
        const { icons } = await session.request('apps.icons', { ids: batch }, 30000);
        if (generation !== this.generation) return;
        // Only the icons asked for: the computer doesn't get to fill the cache with others.
        const asked = Object.fromEntries(batch.filter((id) => Object.prototype.hasOwnProperty.call(icons, id)).map((id) => [id, icons[id] ?? null]));
        this.storeIcons(asked, 'replace');
      }
      this.scheduleIconSave(computer.agentId);
    } catch {
      // Leave them uncached so a later render retries.
    } finally {
      need.forEach((id) => inFlight.delete(id));
    }
  }

  /**
   * A view shows `appId`'s icon: it is kept in memory while shown. Returns the release, for an
   * effect's cleanup.
   */
  holdIcon(appId: string): () => void {
    return this.iconMemory.hold(appId);
  }

  /**
   * Puts icons into the live map, `replace` over what is there or `fill` only what is missing, then
   * drops the least recently used ones past the memory budget (iconMemory.ts).
   */
  private storeIcons(incoming: Record<string, AppIcon | null>, mode: 'replace' | 'fill'): void {
    useLive.setState((s) => {
      const icons = mode === 'replace' ? { ...s.icons, ...incoming } : { ...incoming, ...s.icons };
      const stored = Object.keys(incoming).filter((id) => icons[id] === incoming[id]);
      for (const id of this.iconMemory.evictions(icons, stored)) delete icons[id];
      return { icons };
    });
  }

  /** Every event the computer sends; returns the unsubscribe function. */
  onEvent(listener: (msg: EventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Sends one request to the computer; rejects with a RequestError('offline') when it is not connected. */
  request<M extends Method>(method: M, params: Methods[M]['params'], timeoutMs?: number): Promise<Methods[M]['result']> {
    return this.requireSession().request(method, params, timeoutMs);
  }

  listDir(path?: string, includeFiles = false): Promise<FsListResult> {
    return this.requireSession().request('fs.list', { path, includeFiles }, 15000);
  }

  /** Runs a key's action and drives its light, haptics and the result toast. */
  async runKey(key: DeckKey, page: Page): Promise<void> {
    const live = useLive.getState();
    const action = key.action;
    if (!action) return;
    if (live.keyStates[key.id] === 'run') return;
    if (!this.session?.isOpen) {
      haptics.warning();
      live.setKeyState(key.id, 'fail');
      if (this.computer && this.isHeld(this.computer)) {
        connectCanary.showNotice();
        return;
      }
      live.showToast({
        tone: 'info',
        title: `${this.computer?.name ?? 'The computer'} is offline`,
        detail: 'AuthDeck keeps trying to reconnect. Check that the agent is running.',
      });
      this.wake();
      return;
    }
    live.setKeyState(key.id, 'run');
    try {
      const res = await this.run(action, page.cwd, key.label);
      const output = commandOutput(key, action, res);
      if (output && output.exitCode !== 0) {
        haptics.error();
        useLive.getState().setKeyState(key.id, 'fail');
        useLive.getState().showToast({ tone: 'fail', title: `${key.label || 'Command'} failed with exit code ${output.exitCode}`, output });
        return;
      }
      haptics.success();
      useLive.getState().setKeyState(key.id, 'ok');
      if (res.note) {
        useLive.getState().showToast({ tone: 'info', title: key.label || 'Done', detail: res.note });
      } else if (output) {
        useLive.getState().showToast({ tone: 'ok', title: `${key.label || 'Command'} finished in ${formatDuration(output.durationMs)}`, output });
      }
    } catch (e) {
      haptics.error();
      useLive.getState().setKeyState(key.id, 'fail');
      const err = e instanceof RequestError ? e : new RequestError('failed', e instanceof Error ? e.message : 'Something went wrong.');
      useLive.getState().showToast({ tone: 'fail', title: err.message, detail: err.hint });
    }
  }

  run(action: Action, cwd?: string, label?: string): Promise<Methods['run']['result']> {
    return this.requireSession().request('run', { action, cwd, label: label || undefined }, runTimeoutMs(action));
  }

  private async loadIconCache(agentId: string): Promise<void> {
    try {
      const raw = await readIconCache(agentId);
      if (!raw || this.computer?.agentId !== agentId) return;
      if (raw.length > MAX_ICON_CACHE_CHARS) {
        // Saved by a build without the budget: drop it, and the icons load from the computer.
        await removeIconCache(agentId);
        return;
      }
      // Checked again as apps.icons checks it: a bad entry is dropped, and loads from the computer.
      const cached = checkedIconCache(JSON.parse(raw));
      this.storeIcons(cached, 'fill');
    } catch {
      // The cache only saves a round trip; without it icons load from the computer.
    }
  }

  /**
   * Forgets what a computer sent for display (its app list, icons and focus), on this device and
   * in memory. Never touches its pairing, deck or the vault. For the crash screen.
   */
  async clearDisplayCache(agentId: string): Promise<void> {
    if (this.computer?.agentId === agentId) useLive.setState({ apps: null, appsError: null, focus: null });
    await this.clearIcons(agentId);
  }

  /**
   * Forgets a saved computer: its pairing and deck (store.removeComputer, which also moves to
   * another computer), and what it sent for display. For every Forget button.
   */
  async forgetComputer(agentId: string): Promise<void> {
    useStore.getState().removeComputer(agentId);
    try {
      await this.clearDisplayCache(agentId);
    } catch {
      // The computer is forgotten either way; an icon cache left behind is swept on the next launch.
    }
  }

  /**
   * Forgets a computer's icons, on this device and in memory, and the crash mark that hides them
   * (state/iconCanary.ts): they load from the computer again. For "Clear this computer's icons".
   */
  async clearIcons(agentId: string): Promise<void> {
    if (this.computer?.agentId === agentId) {
      if (this.iconSaveTimer) clearTimeout(this.iconSaveTimer);
      this.iconSaveTimer = null;
      useLive.setState({ icons: {} });
    }
    await removeIconCache(agentId);
    await iconCanary.clear(agentId);
  }

  /**
   * Persist icons that keys use, so decks look right before the computer answers. Only while
   * `agentId` is still the computer whose icons are live: they are its icons, and a save for
   * another computer's key from a partly loaded map would drop that computer's cached icons.
   */
  private scheduleIconSave(agentId: string): void {
    if (this.iconSaveTimer) clearTimeout(this.iconSaveTimer);
    this.iconSaveTimer = setTimeout(() => {
      this.iconSaveTimer = null;
      if (this.computer?.agentId !== agentId) return;
      const deck = entryFor(useStore.getState().decks, agentId);
      const used = new Set<string>();
      deck?.pages.forEach((p) =>
        p.slots.forEach((k) => {
          if (k?.icon.kind === 'app') used.add(k.icon.appId);
          if (k?.action?.type === 'launch') used.add(k.action.appId);
        }),
      );
      const keep = withinIconBudget(used, useLive.getState().icons);
      writeIconCache(agentId, JSON.stringify(keep)).catch(() => undefined);
    }, 1500);
  }
}

/** The icons of `used` apps, in deck order, until MAX_ICON_CACHE_CHARS is reached. */
export function withinIconBudget(used: Iterable<string>, icons: Readonly<Record<string, AppIcon | null>>): Record<string, AppIcon> {
  const keep: [string, AppIcon][] = [];
  let chars = 2; // {}
  for (const id of used) {
    const icon = Object.prototype.hasOwnProperty.call(icons, id) ? icons[id] : null;
    if (!icon) continue;
    const entryChars = JSON.stringify(id).length + JSON.stringify(icon).length + 2; // colon, comma
    if (chars + entryChars > MAX_ICON_CACHE_CHARS) continue;
    keep.push([id, icon]);
    chars += entryChars;
  }
  // fromEntries, so an app id such as "__proto__" stays a key.
  return Object.fromEntries(keep);
}

function commandOutput(key: DeckKey, action: Action, res: Methods['run']['result']): CommandOutput | null {
  if (action.type !== 'command' || action.mode !== 'background') return null;
  return {
    title: key.label || action.command,
    command: action.command,
    exitCode: res.exitCode ?? null,
    output: res.output ?? '',
    durationMs: res.durationMs,
  };
}

export const connection = new ConnectionManager();

/** True when saving `details` would change nothing about the saved computer. */
function sameSavedDetails(saved: Computer, details: Pick<Computer, 'hosts' | 'name' | 'platform'>): boolean {
  const sameHosts = saved.hosts.length === details.hosts.length && saved.hosts.every((h, i) => h === details.hosts[i]);
  return sameHosts && details.name === saved.name && details.platform === saved.platform;
}
