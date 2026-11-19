/** Views for the env screen tests, built from the frozen contract's shapes. */
import type { EnvJoinRequestView, EnvOwnRequestView, EnvRequestView, EnvSetView } from '../../../src/auth/envContract';

/** 18 Nov 2026, 11:48 local time: the design's clock. */
export const NOW = new Date(2026, 10, 18, 11, 48).getTime();
export const MIN = 60_000;
export const DAY = 86_400_000;

export function aSet(patch: Partial<EnvSetView> = {}): EnvSetView {
  return {
    id: 'set-1',
    name: 'acme-api',
    repo: 'acme/api',
    file: '.authdeck/acme-api.env',
    computerName: 'MacBook Pro',
    computerOnline: true,
    role: 'owner',
    ownerLabel: 'Maya Rao · Pixel 8',
    variableCount: 12,
    memberCount: 4,
    grant: null,
    lastReleasedAt: null,
    syncedAt: NOW - 2 * MIN,
    joinRequestCount: 0,
    problems: [],
    removedNote: null,
    refusedNote: null,
    ...patch,
  };
}

export function aRequest(patch: Partial<EnvRequestView> = {}): EnvRequestView {
  return {
    id: 'req-1',
    kind: 'run',
    computerName: 'MacBook Pro',
    setId: 'set-1',
    setName: 'acme-api',
    askedAt: NOW,
    expiresAt: NOW + 60_000,
    needsUnlock: false,
    command: 'npm run dev',
    folder: '~/code/acme-api',
    startedIn: 'Terminal · zsh',
    target: null,
    variableCount: 12,
    changes: null,
    olderOnComputer: false,
    problem: null,
    file: '.authdeck/acme-api.env',
    ...patch,
  };
}

export function aJoin(patch: Partial<EnvJoinRequestView> = {}): EnvJoinRequestView {
  return {
    id: 'join-1',
    via: 'teammate',
    setId: 'set-1',
    setName: 'acme-api',
    label: 'Chen Wei · iPhone 16',
    form: 'phone',
    keyWords: ['harbor', 'velvet', 'quarry', 'mosaic', 'lantern', 'ember'],
    commit: '9b07d13',
    code: null,
    expiresAt: null,
    ownerKeyWords: ['saddle', 'orchard', 'pilot', 'cobalt', 'drift', 'meadow'],
    needsUnlock: false,
    ...patch,
  };
}

export function anOwnRequest(patch: Partial<EnvOwnRequestView> = {}): EnvOwnRequestView {
  return {
    setId: 'set-2',
    setName: 'orbit-api',
    computerName: 'MacBook Pro',
    keyWords: ['canyon', 'pepper', 'blanket', 'orbit', 'sail', 'meadow'],
    madeAt: NOW - DAY,
    ownerLabel: 'Ben Okafor · Pixel 9',
    ownerKeyWords: ['tunnel', 'amber', 'fossil', 'garden', 'quote', 'ripple'],
    ownerConfirmed: false,
    ...patch,
  };
}
