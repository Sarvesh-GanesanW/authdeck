/**
 * The sheets the ".env sets" section opens, drawn at the vault screen's root rather than inside
 * its scroll view: the set and variable sheets are SecureSheets, which draw in the app window and
 * must cover the whole screen. Later ones draw above earlier ones. They close when env sets lock.
 */
import { useEffect } from 'react';

import { BecomeOwnerSheet } from './BecomeOwnerSheet';
import { EnvConfirmSheet } from './EnvConfirmSheet';
import { EnvSetSheet } from './EnvSetSheet';
import { AddMemberSheet, RotateSheet } from './MemberSheets';
import { OldKeySheet } from './OldKeySheet';
import { OwnerWordsSheet } from './OwnerWordsSheet';
import { OwnJoinSheet } from './OwnJoinSheet';
import { envSheets } from './sheetState';
import { useEnv } from './source';
import { VariableSheet } from './VariableSheet';

export function EnvSheets() {
  const open = useEnv().status === 'open';

  // Locking hides every value: whatever was open closes with it, as does leaving the vault.
  useEffect(() => {
    if (!open) envSheets.closeSet();
  }, [open]);
  useEffect(() => envSheets.closeSet, []);

  if (!open) return null;
  return (
    <>
      <EnvSetSheet />
      <VariableSheet />
      <AddMemberSheet />
      <BecomeOwnerSheet />
      <OldKeySheet />
      <RotateSheet />
      <OwnJoinSheet />
      <OwnerWordsSheet />
      <EnvConfirmSheet />
    </>
  );
}
