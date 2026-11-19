import { badRequest } from '../errors';
import {
  NAMED_KEYS,
  PRINTABLE_PUNCTUATION,
  type Action,
  type MacroStep,
  type Modifier,
  type StepAction,
} from '../protocol';

const MODIFIERS: readonly Modifier[] = ['mod', 'ctrl', 'alt', 'shift', 'meta'];
const MAX_TIMEOUT_SEC = 24 * 60 * 60;
const MAX_DELAY_MS = 10 * 60 * 1000;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Fields, key: string, what: string, { allowEmpty = false } = {}): string {
  const value = obj[key];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw badRequest(`The ${what} is missing.`);
  return value;
}

function optionalString(obj: Fields, key: string, what: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`The ${what} must be text.`);
  return value.trim() === '' ? undefined : value;
}

export function isPrintableKey(key: string): boolean {
  return /^[a-z0-9]$/.test(key) || (PRINTABLE_PUNCTUATION as readonly string[]).includes(key);
}

function isValidKey(key: string): boolean {
  return (NAMED_KEYS as readonly string[]).includes(key) || isPrintableKey(key);
}

/** Checks an untrusted action from the tablet and returns it typed, or throws `bad_request`. */
export function validateAction(input: unknown): Action {
  if (!isObject(input)) throw badRequest('The action is missing.');
  if (input.type === 'macro') {
    if (!Array.isArray(input.steps) || input.steps.length === 0) throw badRequest('The macro has no steps.');
    return { type: 'macro', steps: input.steps.map((step, index) => validateMacroStep(step, index)) };
  }
  return validateStepAction(input);
}

function validateMacroStep(input: unknown, index: number): MacroStep {
  if (!isObject(input)) throw badRequest(`Macro step ${index + 1} is not valid.`);
  const delayMs = input.delayMs ?? 0;
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw badRequest(`Macro step ${index + 1} has an invalid delay.`);
  }
  if (isObject(input.action) && input.action.type === 'macro') throw badRequest(`Macro step ${index + 1} is a macro; macros cannot contain macros.`);
  try {
    return { action: validateStepAction(input.action), delayMs };
  } catch (err) {
    throw badRequest(`Macro step ${index + 1}: ${(err as Error).message}`);
  }
}

function validateStepAction(input: unknown): StepAction {
  if (!isObject(input)) throw badRequest('The action is missing.');
  switch (input.type) {
    case 'launch':
      return { type: 'launch', appId: requireString(input, 'appId', 'app'), appName: optionalString(input, 'appName', 'app name') ?? '' };
    case 'hotkey':
      return validateHotkey(input);
    case 'text': {
      const text = requireString(input, 'text', 'text to type', { allowEmpty: true });
      const pressEnter = input.pressEnter === true;
      if (text === '' && !pressEnter) throw badRequest('There is no text to type.');
      if (input.secret !== undefined && typeof input.secret !== 'boolean') throw badRequest('"secret" must be true or false.');
      return { type: 'text', text, pressEnter, ...(input.secret === true ? { secret: true } : {}) };
    }
    case 'command':
      return validateCommand(input);
    case 'url':
      return { type: 'url', url: requireString(input, 'url', 'link').trim() };
    case 'open': {
      const withAppId = optionalString(input, 'withAppId', 'app');
      return { type: 'open', path: requireString(input, 'path', 'file or folder'), ...(withAppId ? { withAppId } : {}) };
    }
    default:
      throw badRequest(`"${String(input.type)}" is not an action this agent knows. Update the AuthDeck agent on the computer.`);
  }
}

function validateHotkey(input: Fields): StepAction {
  if (!Array.isArray(input.modifiers)) throw badRequest('The shortcut modifiers are missing.');
  const modifiers: Modifier[] = [];
  for (const modifier of input.modifiers) {
    if (!MODIFIERS.includes(modifier as Modifier)) throw badRequest(`"${String(modifier)}" is not a modifier key.`);
    if (!modifiers.includes(modifier as Modifier)) modifiers.push(modifier as Modifier);
  }
  const key = requireString(input, 'key', 'shortcut key', { allowEmpty: true });
  if (!isValidKey(key)) throw badRequest(`"${key}" is not a key AuthDeck can press.`);
  const focusAppId = optionalString(input, 'focusAppId', 'app to focus');
  return { type: 'hotkey', modifiers, key, ...(focusAppId ? { focusAppId } : {}) };
}

function validateCommand(input: Fields): StepAction {
  const command = requireString(input, 'command', 'command');
  if (input.mode !== 'terminal' && input.mode !== 'background') throw badRequest('The command mode must be "terminal" or "background".');
  const cwd = optionalString(input, 'cwd', 'working folder');
  const timeoutSec = input.timeoutSec;
  if (timeoutSec !== undefined && (typeof timeoutSec !== 'number' || !(timeoutSec > 0) || timeoutSec > MAX_TIMEOUT_SEC)) {
    throw badRequest('The command timeout must be a positive number of seconds.');
  }
  return { type: 'command', command, mode: input.mode, ...(cwd ? { cwd } : {}), ...(timeoutSec !== undefined ? { timeoutSec } : {}) };
}
