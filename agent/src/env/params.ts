/**
 * Checks what the command sent over the socket. Anything running as the person can connect, so
 * every field is checked for type and size before it is used or passed on to a device.
 */
import type { EnvPlainValue } from '../envcore/types';
import { ENV_LIMITS } from '../envcore/types';
import { EnvCommandFailure } from './socketServer';

const MAX_PATH_CHARS = 4096;
const MAX_WORDS_CHARS = 1024;
const MAX_ARGS = 256;
const MAX_ARG_CHARS = 4096;

export type Params = Record<string, unknown>;

function malformed(what: string): EnvCommandFailure {
  return new EnvCommandFailure({ code: 'failed', detail: `The request's ${what} is missing or malformed. Update the authdeck command to match AuthDeck Agent.` });
}

export function isObject(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(params: Params, name: string, maxChars = MAX_PATH_CHARS): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length > maxChars) throw malformed(name);
  return value;
}

export function nullableString(params: Params, name: string, maxChars = MAX_PATH_CHARS): string | null {
  return params[name] === null ? null : stringField(params, name, maxChars);
}

export function booleanField(params: Params, name: string): boolean {
  if (typeof params[name] !== 'boolean') throw malformed(name);
  return params[name] as boolean;
}

/** The command as typed, for the device's sheet. */
export function invocation(params: Params): string {
  return stringField(params, 'invocation', MAX_WORDS_CHARS);
}

/** The set file's text: at most a little over the cap, which parsing then refuses by name. */
export function fileText(params: Params, name = 'file'): string {
  return stringField(params, name, ENV_LIMITS.fileBytes + 1);
}

export function project(params: Params): { repoRoot: string; remote: string | null; path: string } {
  const value = params.project;
  if (!isObject(value)) throw malformed('project');
  return { repoRoot: stringField(value, 'repoRoot'), remote: nullableString(value, 'remote'), path: stringField(value, 'path') };
}

export function argv(params: Params): string[] | null {
  const value = params.command;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGS || !value.every((arg) => typeof arg === 'string' && arg.length <= MAX_ARG_CHARS)) throw malformed('command');
  return value as string[];
}

export function target(params: Params): { path: string; gitignored: boolean } | null {
  const value = params.target;
  if (value === null) return null;
  if (!isObject(value)) throw malformed('target');
  return { path: stringField(value, 'path'), gitignored: booleanField(value, 'gitignored') };
}

/** Plain values, shape only: names and caps are envcore's checkEnvPlainValues. */
export function plainValues(params: Params): EnvPlainValue[] {
  const value = params.values;
  if (!Array.isArray(value) || value.length > ENV_LIMITS.names + 1) throw malformed('values');
  return value.map((entry) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') throw malformed('values');
    if (entry.name.length > ENV_LIMITS.nameLength + 1 || entry.value.length > ENV_LIMITS.valueBytes + 1) throw malformed('values');
    return { name: entry.name, value: entry.value };
  });
}

export function listFiles(params: Params): { path: string; file: string }[] {
  const value = params.files;
  if (!Array.isArray(value) || value.length > 64) throw malformed('files');
  return value.map((entry) => {
    if (!isObject(entry)) throw malformed('files');
    return { path: stringField(entry, 'path'), file: fileText(entry) };
  });
}
