/**
 * The vault's state in the deck header, shown on pages with 2FA keys: a sunken chip
 * ("Vault open, locks in 4 min", or "Locked") that opens the vault, and a Lock button.
 */
import { View } from 'react-native';

import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { locksInText } from '../../lib/describe';
import { Press } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { SunkenFace, VOXEL } from '../../ui/voxel';
import { HeaderButton, headerMetrics } from './HeaderButton';
import { useSecond } from './otpClock';

/** The chip and, while the vault is open, the Lock button. Nothing when there is no vault. */
export function VaultControls({ compact }: { compact: boolean }) {
  const vault = useVault();
  if (vault.status !== 'open' && vault.status !== 'locked') return null;
  const open = vault.status === 'open';
  return (
    <>
      <VaultChip compact={compact} open={open} locksAt={vault.locksAt} />
      {open ? (
        <HeaderButton
          label="Lock"
          icon="lock"
          iconOnly={compact}
          compact={compact}
          accessibilityLabel="Lock the vault now"
          onPress={() => {
            haptics.tick();
            vault.lock();
          }}
        />
      ) : null}
    </>
  );
}

/** Below this width the tablet header needs the room for its page tabs. */
const ROOMY_HEADER_W = 1400;

/** The open chip's words: "Vault open, locks in 4 min", "Locks in 4 min", or "4 min" on phones. */
function chipText(lockText: string | null, room: 'full' | 'short' | 'phone'): string {
  if (!lockText) return room === 'full' ? 'Vault open' : 'Open';
  if (room === 'phone') return lockText.replace('locks in ', '');
  if (room === 'short') return lockText.charAt(0).toUpperCase() + lockText.slice(1);
  return `Vault open, ${lockText}`;
}

function VaultChip({ compact, open, locksAt }: { compact: boolean; open: boolean; locksAt: number | null }) {
  const cw = useColorway();
  const { width } = useScreen();
  const m = headerMetrics(compact);
  const now = useSecond(open && locksAt !== null) * 1000;
  const lockText = open && locksAt !== null ? locksInText(locksAt, now) : null;
  const text = !open ? 'Locked' : chipText(lockText, compact ? 'phone' : width < ROOMY_HEADER_W ? 'short' : 'full');
  const spoken = !open ? 'Vault locked' : lockText ? `Vault open, ${lockText}` : 'Vault open';
  return (
    <Press
      onPress={() => useAuthUi.getState().open('vault')}
      accessibilityRole="button"
      accessibilityLabel={`${spoken}. Opens the vault`}
      scaleTo={0.97}
      style={{
        height: m.control,
        flexDirection: 'row',
        alignItems: 'center',
        gap: compact ? 6 : 10,
        paddingLeft: compact ? 10 : 14,
        paddingRight: compact ? 12 : 16,
        // Lifts the text onto the same line as the raised buttons' labels beside it.
        paddingBottom: VOXEL / 2,
        flexShrink: 0,
      }}
    >
      <SunkenFace color={cw.plate} lip={cw.lip} />
      <Glyph name={open ? 'unlock' : 'lock'} size={m.icon} color={open ? cw.ok : cw.textDim} />
      <View style={{ position: 'relative' }}>
        <Text variant="label" weight="medium" tone="dim" numberOfLines={1}>
          {text}
        </Text>
      </View>
    </Press>
  );
}
