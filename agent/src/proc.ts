import { spawn, type ChildProcess } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  /** Written to stdin, which is then closed. */
  input?: string;
  timeoutMs?: number;
  /** Keep only this many trailing characters of the interleaved output. */
  tailChars?: number;
  /** Pass args to Windows as-is (needed for cmd.exe quoting). */
  verbatimArgs?: boolean;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order, trimmed to tailChars. */
  combined: string;
  timedOut: boolean;
}

const DEFAULT_TAIL_CHARS = 8000;
/**
 * The most of stdout and of stderr kept, each. A command that prints without end (a background
 * command from a device, or a chatty tool) must not grow a string until it can't be held.
 */
export const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;
/** How long to wait for buffered output after the process exits; children that keep the pipes open must not block us. */
const OUTPUT_GRACE_MS = 200;

/** Runs a program with an argv array (no shell), capturing output; rejects only when it cannot be started. */
export function runProcess(cmd: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        // Own process group on posix so a timeout can kill the whole tree.
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: options.verbatimArgs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    // Listen before anything else: a spawn that fails (EMFILE, ENOENT) reports it here, later.
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    const { stdin, stdout: out, stderr: errOut } = child;
    if (!stdin || !out || !errOut) {
      // The pipes could not be made; the 'error' event above says why.
      return;
    }
    for (const stream of [stdin, out, errOut]) stream.on('error', () => {});

    const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
    let stdout = '';
    let stderr = '';
    let combined = '';
    let timedOut = false;

    const appendCombined = (chunk: string) => {
      combined += chunk;
      if (combined.length > tailChars * 2) combined = combined.slice(-tailChars);
    };
    out.setEncoding('utf8');
    errOut.setEncoding('utf8');
    out.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.slice(0, MAX_CAPTURE_CHARS - stdout.length);
      appendCombined(chunk);
    });
    errOut.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.slice(0, MAX_CAPTURE_CHARS - stderr.length);
      appendCombined(chunk);
    });
    // The program may exit without reading its input; that is not our failure (stdin's listener above).
    stdin.end(options.input ?? '');

    timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, options.timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      out.destroy();
      errOut.destroy();
      resolve({ exitCode, stdout, stderr, combined: combined.slice(-tailChars), timedOut });
    };

    child.once('close', (code) => finish(code));
    child.once('exit', (code) => setTimeout(() => finish(code), OUTPUT_GRACE_MS));
  });
}

/** Starts a program that should outlive this request (apps, terminals, openers). Resolves once it has started. */
export function spawnDetached(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; verbatimArgs?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: options.verbatimArgs,
    });
    child.on('error', reject); // stays: a later error must not go unheard
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {
      child.kill();
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function isSpawnNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Runs async work over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
