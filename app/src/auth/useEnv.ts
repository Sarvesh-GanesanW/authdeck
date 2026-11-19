/**
 * The one hook screens use for env sets (envContract.ts). On a phone or tablet it is the env
 * engine (./env); on web, where there is no secure storage, it is the sample sets the screens
 * were built against (screens/env/mock.ts), as useVault does for the vault.
 */
import { useEffect, useMemo } from 'react';

import type { EnvActions, EnvApi } from './envContract';
import { envEngine, holdEnvEngine, useEnvSnapshot } from './env/app';
import { isMockVault } from './useVault';
import { mockEnvActions, useMockEnv } from '../screens/env/mock';

const engineEnvActions: EnvActions = {
  detail: (setId) => envEngine.detail(setId),
  history: (setId, before) => envEngine.history(setId, before),
  reveal: (setId, name) => envEngine.reveal(setId, name),
  checkVariable: (name, value) => envEngine.checkVariable(name, value),
  saveVariable: (setId, variable) => envEngine.saveVariable(setId, variable),
  parseDotenv: (text) => envEngine.parseDotenv(text),
  addVariables: (setId, values) => envEngine.addVariables(setId, values),
  deleteVariable: (setId, name) => envEngine.deleteVariable(setId, name),
  teammateSteps: (setId) => envEngine.teammateSteps(setId),
  approveJoin: (requestId) => envEngine.approveJoin(requestId),
  declineJoin: (requestId) => envEngine.declineJoin(requestId),
  acceptOwnDeviceJoin: (requestId) => envEngine.acceptOwnDeviceJoin(requestId),
  requestJoin: (setId) => envEngine.requestJoin(setId),
  cancelJoin: () => envEngine.cancelJoin(),
  removeMember: (setId, memberId) => envEngine.removeMember(setId, memberId),
  answer: (requestId, answer) => envEngine.answer(requestId, answer),
  dismissEnded: (requestId) => envEngine.dismissEnded(requestId),
  pushedValue: (requestId, name) => envEngine.pushedValue(requestId, name),
  endGrant: (setId) => envEngine.endGrant(setId),
  becomeOwner: (setId, phrase) => envEngine.becomeOwner(setId, phrase),
  deleteRemovedSet: (setId) => envEngine.deleteRemovedSet(setId),
  setPersonName: (name) => envEngine.setPersonName(name),
  fixOldKeyLines: (setId, keep, reviewedNames) => envEngine.fixOldKeyLines(setId, keep, reviewedNames),
  confirmOwnerWords: (setId, shownWords) => envEngine.confirmOwnerWords(setId, shownWords),
  cancelOwnRequest: (setId) => envEngine.cancelOwnRequest(setId),
};

function useEngineEnv(): EnvApi {
  useEffect(() => holdEnvEngine(), []);
  const snapshot = useEnvSnapshot();
  return useMemo(() => ({ ...snapshot, ...engineEnvActions }), [snapshot]);
}

function useMockEnvApi(): EnvApi {
  const { data: _data, pushes: _pushes, ...snapshot } = useMockEnv();
  return { ...snapshot, ...mockEnvActions };
}

export const useEnv: () => EnvApi = isMockVault ? useMockEnvApi : useEngineEnv;
