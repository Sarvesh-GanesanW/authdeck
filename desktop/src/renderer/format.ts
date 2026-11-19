import type { ActivityOutcome, AgentStatus, CliPathState, Platform } from '../shared/state';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

export interface Status {
  tone: Tone;
  text: string;
}

export interface StatusInputs {
  agent: AgentStatus;
  pairedDevices: number;
  needsAccessibility: boolean;
}

export function statusOf({ agent, pairedDevices, needsAccessibility }: StatusInputs): Status {
  switch (agent.state) {
    case 'starting':
      return { tone: 'idle', text: 'Starting…' };
    case 'port-in-use':
    case 'failed':
      return { tone: 'bad', text: 'Not running' };
    case 'running':
      if (needsAccessibility) return { tone: 'warn', text: 'Needs permission' };
      if (pairedDevices === 0) return { tone: 'warn', text: 'Waiting for a device' };
      if (agent.hosts.length === 0) return { tone: 'warn', text: 'No network connection' };
      return { tone: 'ok', text: `Ready on ${agent.hosts[0]}` };
  }
}

/** What is left of the pairing window, as m:ss. */
export function timeLeft(closesAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((closesAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function clockTime(at: number): string {
  return TIME.format(at);
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export interface LastSeen {
  /** Fits the device card. */
  short: string;
  full: string;
}

export function lastSeen(isoTime: string, now: number = Date.now()): LastSeen {
  const at = Date.parse(isoTime);
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / MS_PER_DAY);
  if (daysAgo === 0) return { short: `Seen at ${clockTime(at)}`, full: `Last seen today, ${clockTime(at)}` };
  if (daysAgo === 1) return { short: 'Seen yesterday', full: `Last seen yesterday, ${clockTime(at)}` };
  return { short: `Seen ${DAY.format(at)}`, full: `Last seen ${DAY.format(at)}, ${clockTime(at)}` };
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export interface OutcomeView {
  tone: Tone;
  text: string;
  /** The agent's full explanation, shown on hover. */
  explanation?: string;
}

const FAILURE_LABELS: Record<string, string> = {
  unauthorized: 'Not allowed',
  bad_request: 'Invalid key',
  not_found: 'Not found',
  permission: 'Needs permission',
  missing_tool: 'Missing tool',
  unsupported: 'Not supported',
  timeout: 'Timed out',
};

export function outcomeView(outcome: ActivityOutcome): OutcomeView {
  switch (outcome.state) {
    case 'running':
      return { tone: 'warn', text: 'Running…' };
    case 'done':
      if (outcome.exitCode === undefined) return { tone: 'ok', text: 'Done' };
      if (outcome.exitCode === 0) return { tone: 'ok', text: `Finished in ${duration(outcome.durationMs)}` };
      return { tone: 'bad', text: `Exit code ${outcome.exitCode}` };
    case 'failed': {
      const { failure } = outcome;
      const explanation = [failure.message, failure.hint].filter(Boolean).join(' ');
      if (failure.permission === 'accessibility') return { tone: 'bad', text: 'Needs Accessibility', explanation };
      if (failure.permission === 'automation') return { tone: 'bad', text: 'Needs Automation', explanation };
      return { tone: 'bad', text: FAILURE_LABELS[failure.code] ?? 'Failed', explanation };
    }
  }
}

/** Where the agent keeps running after the window closes. */
export function backgroundPlace(platform: Platform): string {
  if (platform === 'macos') return 'the menu bar';
  if (platform === 'windows') return 'the system tray';
  return 'the tray';
}

export interface CliPathView {
  tone: Tone;
  /** Next to the command's name in the footer: "on your PATH". */
  text: string;
  /** The full story, on hover. */
  title: string;
}

export function cliPathView(cliPath: CliPathState): CliPathView {
  switch (cliPath.state) {
    case 'absent':
      return { tone: 'idle', text: 'not on your PATH', title: 'Put the authdeck command on your PATH to use env sets from a terminal.' };
    case 'installed':
      return cliPath.onPath
        ? { tone: 'ok', text: 'on your PATH', title: cliPath.location }
        : { tone: 'warn', text: 'not on your PATH yet', title: `${cliPath.location}: its folder isn't on your PATH yet.` };
    case 'stale':
      return { tone: 'warn', text: 'needs fixing', title: `${cliPath.location} runs another copy of AuthDeck Agent.` };
    case 'taken':
      return { tone: 'warn', text: 'name taken', title: `${cliPath.location} belongs to another program.` };
  }
}
