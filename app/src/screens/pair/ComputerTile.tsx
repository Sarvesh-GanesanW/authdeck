/** Small pieces shared by the pairing screen and the computer list in settings. */
import { View } from 'react-native';

import { platformName } from '../../lib/describe';
import type { Platform } from '../../protocol';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { RaisedFace, snap, VOXEL } from '../../ui/voxel';

const PLATFORM_GLYPH: Record<Platform, GlyphName> = { macos: 'laptop', windows: 'monitor', linux: 'server' };

/** A tile's front face; the glyph is centred over the top face above it. */
const TILE_DEPTH = VOXEL;

/** Small voxel block with a picture of the kind of computer. */
export function OsTile({ platform, size = 52 }: { platform: Platform | null; size?: number }) {
  const cw = useColorway();
  const tone = cw.caps.mod;
  const side = snap(size);
  return (
    <View style={{ width: side, height: side, alignItems: 'center', justifyContent: 'center', paddingBottom: TILE_DEPTH }}>
      <RaisedFace tone={tone} depth={TILE_DEPTH} />
      <Glyph name={platform ? PLATFORM_GLYPH[platform] : 'monitor'} size={24} color={tone.legend} />
    </View>
  );
}

/** "macOS, 192.168.1.24", leaving out what is unknown. */
export function computerDetail(platform: Platform | null, host: string | null): string {
  return [platform ? platformName(platform) : null, host].filter(Boolean).join(', ');
}

/**
 * A square status light. `halo` adds a slightly bigger square of the same colour behind it,
 * so a lit lamp reads at a glance.
 */
export function Lamp({ color, size = 2 * VOXEL, halo = true }: { color: string; size?: number; halo?: boolean }) {
  const spread = VOXEL / 2;
  return (
    <View style={{ width: size, height: size }}>
      {halo ? (
        <View style={{ position: 'absolute', top: -spread, left: -spread, right: -spread, bottom: -spread, backgroundColor: color, opacity: 0.25 }} />
      ) : null}
      <View style={{ flex: 1, backgroundColor: color }} />
    </View>
  );
}

/** The AuthDeck mark: one small amber key block and the name. */
export function BrandMark({ large }: { large: boolean }) {
  const cw = useColorway();
  const side = large ? 9 * VOXEL : 7 * VOXEL;
  const depth = large ? 2 * VOXEL : VOXEL;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: large ? 12 : 10 }} accessibilityRole="header" accessibilityLabel="AuthDeck">
      <View style={{ width: side, height: side + depth }}>
        <RaisedFace tone={cw.caps.a} depth={depth} shadow={cw.shadow} />
      </View>
      <Text variant="heading">AuthDeck</Text>
    </View>
  );
}
