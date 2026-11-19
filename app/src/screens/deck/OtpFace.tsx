/**
 * What a 2FA key shows: the issuer and account on top, the live code large below them, and a
 * ten-cell countdown on the front face (or under the code on keys too small for one). Small keys
 * drop the icon and the account line and centre the name over the code; the name always stays
 * (see otpLayout).
 *
 * Only the code and the countdown subscribe to the clock, so each second re-renders those two
 * small leaves, never the keycap around them.
 */
import { memo, useMemo } from 'react';
import { useWindowDimensions, View } from 'react-native';

import type { CodeView } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { formatOtpCode } from '../../lib/describe';
import type { DeckKey, KeyIcon } from '../../state/model';
import type { CapTone } from '../../theme/colorways';
import { fonts } from '../../theme/type';
import { Glyph, KeyIconView } from '../../ui/Icon';
import { keyMetrics } from '../../ui/Keycap';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { useKeyCode } from './otpClock';
import { CODE_TRACKING, codeLineHeight, otpLayout } from './otpLayout';

/** The countdown turns amber this many seconds before the code changes. */
export const WARN_SECONDS = 5;
const BAR_CELLS = 10;

export interface OtpFaceProps {
  accountId: string;
  /** Shown while the vault can't say which account this is (locked, or account removed). */
  fallbackTitle: string;
  icon: KeyIcon;
  tone: CapTone;
  /** The key's box, as given to Keycap. */
  width: number;
  height: number;
  /** False for keys off screen: they keep their code without ticking. */
  ticking: boolean;
}

export const OtpFace = memo(function OtpFace({ accountId, fallbackTitle, icon, tone, width, height, ticking }: OtpFaceProps) {
  const vault = useVault();
  const { fontScale } = useWindowDimensions();
  const account = vault.accounts.find((a) => a.id === accountId);
  const m = keyMetrics(width, height, true);
  const title = (account ? account.issuer || account.label : fallbackTitle) || 'Account';
  const subtitle = account?.issuer ? account.label : '';
  const digits = account ? account.digits : 6;
  const groupable = account?.type !== 'steam' && digits >= 6;
  const open = vault.status === 'open';
  const s = useMemo(
    () => otpLayout(m, title, digits, groupable, open, fontScale),
    // The metrics follow from the key's width and height.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m.w, m.capH, m.v, m.sub, title, digits, groupable, open, fontScale],
  );
  const center = !s.showIcon;
  const glyph = m.v === 4 ? 8 : 4;

  const bottom =
    vault.status === 'open' && !account ? (
      <Text
        numberOfLines={2}
        adjustsFontSizeToFit
        style={{ fontFamily: fonts.plex.medium, fontSize: s.label, lineHeight: Math.round(s.label * 1.35), color: tone.sub, textAlign: center ? 'center' : 'left' }}
      >
        {accountId ? 'Not in the vault' : 'Pick an account'}
      </Text>
    ) : vault.status === 'open' ? (
      <View style={{ marginHorizontal: -s.bleed }}>
        <CodeLine accountId={accountId} size={s.code} grouped={s.grouped} split={s.split} center={center} tone={tone} ticking={ticking} />
      </View>
    ) : center ? (
      // Too small for words: the lock alone says the vault is shut.
      <View style={{ alignItems: 'center' }} accessible accessibilityLabel={vault.status === 'none' ? 'No vault' : 'Locked'}>
        <Glyph name="lock" size={s.icon} color={tone.legend} />
      </View>
    ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: glyph }}>
        <Glyph name="lock" size={s.icon} color={tone.legend} />
        <Text numberOfLines={1} style={{ fontFamily: fonts.plex.semibold, fontSize: s.issuer, lineHeight: Math.round(s.issuer * 1.3), color: tone.legend }}>
          {vault.status === 'none' ? 'No vault' : 'Locked'}
        </Text>
      </View>
    );

  return (
    <View style={{ flex: 1 }}>
      {center ? (
        // One Text per line, as fitLabel laid them out: breaks only at spaces, never inside a word.
        // Centred in the room above the code, as normal small keys centre their label.
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: s.nameTop, paddingHorizontal: s.nameInset }}>
          {s.title?.lines.map((line, i) => (
            <Text
              key={i}
              numberOfLines={1}
              ellipsizeMode="clip"
              style={{ fontFamily: fonts.plex.semibold, fontSize: s.title!.fontSize, lineHeight: s.title!.lineHeight, color: tone.legend, textAlign: 'center' }}
            >
              {line}
            </Text>
          ))}
        </View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: glyph, paddingRight: m.led + m.v * 2 }}>
            <KeyIconView icon={icon} size={s.icon} color={tone.legend} />
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, fontFamily: fonts.plex.semibold, fontSize: s.issuer, lineHeight: Math.round(s.issuer * 1.3), color: tone.legend }}
            >
              {title}
            </Text>
          </View>
          {subtitle ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{ fontFamily: fonts.plex.regular, fontSize: s.label, lineHeight: Math.round(s.label * 1.35), color: tone.sub, marginTop: 2 }}
            >
              {subtitle}
            </Text>
          ) : null}
        </>
      )}
      {center ? null : <View style={{ flex: 1 }} />}
      {bottom}
      {s.countdown && account && open ? (
        <View style={{ marginTop: m.v }}>
          <Countdown accountId={accountId} ticking={ticking} tone={tone} small />
        </View>
      ) : null}
    </View>
  );
});

function isWarning(code: CodeView | null): boolean {
  return !!code && code.period > 0 && code.secondsLeft <= WARN_SECONDS;
}

const CodeLine = memo(function CodeLine({
  accountId,
  size,
  grouped,
  split,
  center,
  tone,
  ticking,
}: {
  accountId: string;
  size: number;
  grouped: boolean;
  /** The two halves on two lines. */
  split: boolean;
  center: boolean;
  tone: CapTone;
  ticking: boolean;
}) {
  const cw = useColorway();
  const code = useKeyCode(accountId, ticking);
  const warn = isWarning(code);
  const digits = code?.code ?? '';
  const half = Math.ceil(digits.length / 2);
  const lines = !code ? [' '] : split ? [digits.slice(0, half), digits.slice(half)] : [grouped ? formatOtpCode(digits) : digits];
  return (
    <View accessible accessibilityLabel={code ? formatOtpCode(digits) : undefined} style={{ alignItems: center ? 'center' : 'flex-start' }}>
      {lines.map((line, i) => (
        <Text
          key={i}
          numberOfLines={1}
          // otpLayout sizes the code to fit; this only guards a font that runs wider than Plex Mono.
          adjustsFontSizeToFit
          style={{
            fontFamily: fonts.plex.semibold,
            fontSize: size,
            lineHeight: codeLineHeight(size),
            letterSpacing: size * CODE_TRACKING,
            color: warn ? warnColor(cw, tone) : tone.legend,
          }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
});

/** Amber, unless the key itself is amber; then the danger red still stands out. */
function warnColor(cw: ReturnType<typeof useColorway>, tone: CapTone): string {
  return tone === cw.caps.a ? cw.danger : cw.run;
}

/** Ten pixel cells that empty as the code ages, and the seconds left. HOTP codes have none. */
export const Countdown = memo(function Countdown({
  accountId,
  ticking,
  tone,
  small,
}: {
  accountId: string;
  ticking: boolean;
  tone: CapTone;
  /** On the top face of a small key rather than on a front face. */
  small?: boolean;
}) {
  const cw = useColorway();
  const code = useKeyCode(accountId, ticking);
  if (!code || code.period <= 0) return null;
  const warn = isWarning(code);
  const lit = Math.max(1, Math.round((code.secondsLeft / code.period) * BAR_CELLS));
  const on = warn ? warnColor(cw, tone) : cw.ok;
  const cell = small ? 4 : 8;
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: small ? 6 : 10, alignSelf: 'stretch' }}
      accessible
      accessibilityLabel={`${code.secondsLeft} seconds left`}
    >
      <View style={{ flex: 1, flexDirection: 'row', gap: small ? 2 : 3, height: cell }}>
        {Array.from({ length: BAR_CELLS }, (_, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: i < lit ? on : tone.shade }} />
        ))}
      </View>
      <Text
        style={{
          fontFamily: fonts.plex.medium,
          fontSize: small ? 10 : 12,
          lineHeight: small ? 12 : 16,
          color: warn ? on : tone.sub,
          minWidth: small ? 22 : 30,
          textAlign: 'right',
        }}
      >
        {`${code.secondsLeft} s`}
      </Text>
    </View>
  );
});

/** Keycap's `face` and `front` for a 2FA key of the given size. */
export function otpFaces(key: DeckKey, tone: CapTone, width: number, height: number, ticking: boolean) {
  const accountId = key.otp?.accountId ?? '';
  const face = <OtpFace accountId={accountId} fallbackTitle={key.label} icon={key.icon} tone={tone} width={width} height={height} ticking={ticking} />;
  const front = keyMetrics(width, height, true).sub ? <FrontCountdown accountId={accountId} ticking={ticking} tone={tone} /> : undefined;
  return { face, front };
}

/** The front face's countdown, or an empty face while there is no ticking code to count. */
function FrontCountdown({ accountId, ticking, tone }: { accountId: string; ticking: boolean; tone: CapTone }) {
  return (
    <View style={{ alignSelf: 'stretch', paddingHorizontal: 4 }}>
      <Countdown accountId={accountId} ticking={ticking} tone={tone} />
    </View>
  );
}
