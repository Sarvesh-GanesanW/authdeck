/**
 * The "2FA code" key type in the key editor: pick which vault account the key shows and types,
 * from a searchable list, or add a new account. Without a vault it offers to set one up.
 */
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import type { AccountView } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, Press, PrimaryButton } from '../../ui/controls';
import { Glyph, resolveGlyph } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { Ring, Shape } from '../../ui/voxel';
import { otpGlyph } from '../../state/templates';
import { useAddAccount } from '../deck/useAddAccount';
import { searchable } from './actionModel';
import { SearchField } from './AppPicker';
import { Notice } from './parts';

/** Above this many accounts the list gets a search field. */
const SEARCH_FROM = 6;
const ROW_STEPS = 1;

export function OtpEditor({ accountId, onPick }: { accountId: string; onPick: (account: AccountView) => void }) {
  const vault = useVault();
  const [query, setQuery] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const addAccount = useAddAccount((added) => {
    const first = added[0];
    if (first) onPick(first);
  });

  const shown = useMemo(() => {
    const q = searchable(query);
    if (!q) return vault.accounts;
    return vault.accounts.filter((a) => searchable(`${a.issuer} ${a.label} ${a.team ?? ''}`).includes(q));
  }, [vault.accounts, query]);

  if (vault.status === 'loading') return <Text tone="dim">Opening the vault…</Text>;
  if (vault.status === 'none') {
    return (
      <View style={{ gap: 14 }}>
        <Notice
          title="Set up the authenticator first"
          detail="It keeps your 2FA codes on this device, and a key can then type one on the computer when you tap it."
        />
        <View style={{ flexDirection: 'row' }}>
          <PrimaryButton label="Set up the authenticator" icon="lock" onPress={() => useAuthUi.getState().open('intro')} />
        </View>
      </View>
    );
  }
  if (vault.status === 'locked') {
    const unlock = async () => {
      setUnlocking(true);
      setUnlockError(null);
      try {
        await vault.unlock();
      } catch (e) {
        setUnlockError(e instanceof Error ? e.message : 'The vault stayed locked.');
      } finally {
        setUnlocking(false);
      }
    };
    return (
      <View style={{ gap: 14 }}>
        <Notice title="The vault is locked" detail="Unlock it to choose an account for this key." />
        {unlockError ? <Notice tone="fail" title={unlockError} detail="Try again." /> : null}
        <View style={{ flexDirection: 'row' }}>
          <GhostButton label={unlocking ? 'Unlocking…' : 'Unlock'} icon="unlock" disabled={unlocking} onPress={() => void unlock()} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {vault.accounts.length > SEARCH_FROM ? <SearchField value={query} onChange={setQuery} placeholder="Search accounts" /> : null}
      {vault.accounts.length === 0 ? (
        <Notice title="No accounts yet" detail="Add one from the site's 2FA setup page; the key then shows its code." />
      ) : shown.length === 0 ? (
        <Notice title={`No accounts match “${query}”`} detail="Check the spelling, or add the account." />
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel="Account" style={{ gap: 4 }}>
          {shown.map((a) => (
            <AccountRow key={a.id} account={a} on={a.id === accountId} onPress={() => onPick(a)} />
          ))}
        </View>
      )}
      <View style={{ flexDirection: 'row' }}>
        <GhostButton small label="Add account" icon="plus" onPress={addAccount} />
      </View>
    </View>
  );
}

function AccountRow({ account, on, onPress }: { account: AccountView; on: boolean; onPress: () => void }) {
  const cw = useColorway();
  return (
    <Press
      onPress={() => {
        if (!on) haptics.tick();
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={[account.issuer, account.label, account.team ? `shared with ${account.team}` : ''].filter(Boolean).join(', ')}
      scaleTo={0.98}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 12, paddingVertical: 8 }}
    >
      {on ? (
        <>
          <Shape steps={ROW_STEPS} color={cw.surfaceAlt} />
          <Ring steps={ROW_STEPS} color={cw.focus} gap={0} />
        </>
      ) : null}
      <Glyph name={resolveGlyph(otpGlyph(account))} size={24} color={on ? cw.text : cw.textDim} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text weight="medium" numberOfLines={1}>
          {account.issuer || account.label || 'Unnamed account'}
        </Text>
        {account.issuer && account.label ? (
          <Text variant="label" tone="dim" numberOfLines={1}>
            {account.team ? `${account.label} · ${account.team}` : account.label}
          </Text>
        ) : null}
      </View>
      {on ? <Glyph name="check" size={24} color={cw.focus} /> : null}
    </Press>
  );
}
