/**
 * One page of keys fitted to the space it has. Every slot has a socket; keys float
 * above them. In edit mode empty sockets show a plus, and keys can be dragged.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { LayoutAnimationConfig, useSharedValue } from 'react-native-reanimated';

import type { Platform } from '../../protocol';
import type { Page } from '../../state/model';
import { useStore } from '../../state/store';
import { Press } from '../../ui/controls';
import { fonts } from '../../theme/type';
import { Glyph } from '../../ui/Icon';
import { keyMetrics } from '../../ui/Keycap';
import { useColorway } from '../../ui/theme';
import { Text } from '../../ui/Text';
import { SunkenFace } from '../../ui/voxel';
import { DeckKeyView, type KeyHandlers } from './DeckKeyView';
import { type Geo, gridGeometry, previewSlot, slotOrigin } from './grid';
import { pageCells } from './twoFaPage';

interface Props {
  agentId: string;
  page: Page;
  width: number;
  height: number;
  editing: boolean;
  /** The page on screen, as opposed to a neighbour waiting off to the side. */
  current: boolean;
  selectedId: string | null;
  dimmed: boolean;
  platform: Platform;
  showSublegend: boolean;
  onKeyPress: (pageId: string, index: number) => void;
  onKeyMenu: KeyHandlers['onMenu'];
  onKeyRemove: (pageId: string, index: number) => void;
  onSocketPress: (pageId: string, index: number) => void;
  /** An empty spot on a 2FA page was tapped. */
  onAddAccount: (pageId: string, index: number) => void;
}

export const PageGrid = memo(function PageGrid(props: Props) {
  const { agentId, page, width, height, editing, current, selectedId, dimmed, platform, showSublegend } = props;
  // A 2FA page lays out only what it holds (pageCells); a normal page, all its slots.
  const { cells, shown } = pageCells(page, editing);
  const geo = useMemo(() => gridGeometry(cells, width, height), [cells, width, height]);
  const slots = shown < page.slots.length ? page.slots.slice(0, shown) : page.slots;
  const geoSV = useSharedValue<Geo>(geo);
  const [preview, setPreview] = useState<{ from: number; to: number } | null>(null);

  useEffect(() => {
    geoSV.value = geo;
  }, [geo, geoSV]);
  useEffect(() => {
    if (!editing) setPreview(null);
  }, [editing]);

  const { onKeyPress, onKeyRemove, onSocketPress, onAddAccount, onKeyMenu } = props;
  const pageId = page.id;
  const onPress = useCallback((i: number) => onKeyPress(pageId, i), [onKeyPress, pageId]);
  const onRemove = useCallback((i: number) => onKeyRemove(pageId, i), [onKeyRemove, pageId]);
  const isOtpPage = !!page.otp;
  // A 2FA page offers one "Add account" spot, the first empty one; its other empty spots stay plain until editing.
  const firstEmpty = isOtpPage && !editing ? page.slots.findIndex((k) => !k) : -1;
  const onSocket = useCallback(
    (i: number) => (isOtpPage ? onAddAccount(pageId, i) : onSocketPress(pageId, i)),
    [isOtpPage, onAddAccount, onSocketPress, pageId],
  );
  const onHover = useCallback((from: number, to: number) => setPreview({ from, to }), []);
  const onDrop = useCallback(
    (from: number, to: number) => {
      setPreview(null);
      if (from !== to) useStore.getState().moveKey(agentId, pageId, from, to);
    },
    [agentId, pageId],
  );

  return (
    <LayoutAnimationConfig skipEntering skipExiting>
      <View style={{ width, height }}>
        {slots.map((k, i) => (
          <Socket
            key={`s${i}`}
            geo={geo}
            slot={i}
            empty={!k}
            editing={editing}
            addsAccount={isOtpPage && (editing || i === firstEmpty)}
            onPress={onSocket}
          />
        ))}
        {slots.map((k, i) =>
          k ? (
            <DeckKeyView
              key={k.id}
              data={k}
              index={i}
              slot={preview ? previewSlot(i, preview.from, preview.to) : i}
              geo={geo}
              geoSV={geoSV}
              editing={editing}
              wobble={editing && current}
              selected={editing && k.id === selectedId}
              dimmed={dimmed}
              // Only a 2FA key's face changes with this; other keys skip re-rendering on a page switch.
              ticking={current && !!k.otp}
              platform={platform}
              showSublegend={showSublegend}
              onPress={onPress}
              onMenu={onKeyMenu}
              onRemove={onRemove}
              onHover={onHover}
              onDrop={onDrop}
            />
          ) : null,
        )}
      </View>
    </LayoutAnimationConfig>
  );
});

/**
 * The sunken socket a key sits in. Empty ones become "add key" buttons in edit mode; on a
 * 2FA page they always offer to add an account. Memoised, so a page switch, which re-renders the
 * page, leaves its sockets alone.
 */
const Socket = memo(function Socket({
  geo,
  slot,
  empty,
  editing,
  addsAccount,
  onPress,
}: {
  geo: Geo;
  slot: number;
  empty: boolean;
  editing: boolean;
  addsAccount: boolean;
  onPress: (slot: number) => void;
}) {
  const cw = useColorway();
  const { x, y } = slotOrigin(geo, slot);
  const m = keyMetrics(geo.cellW, geo.cellH, false);
  const pressable = empty && (editing || addsAccount);
  const style = {
    position: 'absolute' as const,
    left: x,
    top: y,
    width: m.w,
    height: m.h,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: m.v === 4 ? 10 : 4,
    opacity: empty && !pressable ? 0.55 : 1,
  };
  const face = <SunkenFace color={cw.socket} lip={cw.lip} steps={m.steps} v={m.v} lipDepth={2 * m.v} />;
  if (!pressable) {
    return (
      <View style={style} pointerEvents="none">
        {face}
      </View>
    );
  }
  const glyph = m.v === 4 ? (addsAccount ? 24 : 36) : addsAccount ? 12 : 24;
  return (
    <Press onPress={() => onPress(slot)} accessibilityLabel={addsAccount ? 'Add account' : `Add a key in slot ${slot + 1}`} scaleTo={0.94} style={style}>
      {face}
      <Glyph name="plus" size={glyph} color={cw.textFaint} />
      {addsAccount ? (
        <Text numberOfLines={1} style={{ fontFamily: fonts.plex.medium, fontSize: m.v === 4 ? 14 : 11, lineHeight: m.v === 4 ? 18 : 14, color: cw.textFaint }}>
          Add account
        </Text>
      ) : null}
    </Press>
  );
});
