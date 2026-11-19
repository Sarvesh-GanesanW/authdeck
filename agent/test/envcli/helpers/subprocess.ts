/** Runs the command as its own process (for signals, stdio and exit codes), with the fake core. */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const ENTRY = path.join(import.meta.dirname, 'entry.ts');
const AGENT_ROOT = path.join(import.meta.dirname, '..', '..', '..');

export interface Spawned {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves once stderr or stdout contains `text`. */
  waitFor(text: string): Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnCli(argv: string[], options: { cwd: string; home: string; env?: NodeJS.ProcessEnv }): Spawned {
  const child = spawn(process.execPath, ['--import', path.join(AGENT_ROOT, 'node_modules/tsx/dist/loader.mjs'), ENTRY, ...argv], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AUTHDECK_HOME: options.home, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const waiters: { text: string; resolve: () => void }[] = [];
  const check = () => {
    for (const waiter of [...waiters]) {
      if (out.includes(waiter.text) || err.includes(waiter.text)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  child.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    check();
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8');
    check();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    waitFor: (text) =>
      new Promise<void>((resolve) => {
        waiters.push({ text, resolve });
        check();
      }),
    exit,
  };
}
