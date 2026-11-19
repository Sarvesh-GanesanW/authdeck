/**
 * Variables that change how programs start (NODE_OPTIONS, LD_PRELOAD, DYLD_*, BASH_ENV, PATH…).
 * Any member can sign one, so `run` never injects them unless the person allows the name on this
 * computer for this run (--allow); `pull` writes them, since the file is the person's to read,
 * but says so. Which names count is the core's (envLoadsCode).
 */
import type { EnvPlainValue } from '../envcore/types';

export type LoadsCode = (name: string) => boolean;

const REASON = 'it changes how programs start';

/** Splits values into those safe to inject and the names held back. */
export function holdBackCodeLoading(values: readonly EnvPlainValue[], loadsCode: LoadsCode, allowed: ReadonlySet<string>): { kept: EnvPlainValue[]; skipped: string[] } {
  const kept: EnvPlainValue[] = [];
  const skipped: string[] = [];
  for (const value of values) {
    if (loadsCode(value.name) && !allowed.has(value.name)) skipped.push(value.name);
    else kept.push(value);
  }
  return { kept, skipped };
}

/** run: "Skipped NODE_OPTIONS: it changes how programs start. Add --allow NODE_OPTIONS to use it." */
export function skippedWords(name: string): string {
  return `Skipped ${name}: ${REASON}. Add --allow ${name} to use it.`;
}

/** pull: the same reason, for a name that was written. */
export function writtenWords(file: string, name: string): string {
  return `! ${file} sets ${name}: ${REASON}. Check its value before a program loads ${file}.`;
}
