/** Colourway choice with a tiny voxel plate of each set's keys, plus "match system". */
import { View } from 'react-native';

import { haptics } from '../../lib/haptics';
import type { ColorwaySetting } from '../../state/store';
import { CAP_COLORS, COLORWAY_LIST, COLORWAYS, type Colorway } from '../../theme/colorways';
import { Press } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { RaisedFace, Ring, Shape, SunkenFace, VOXEL } from '../../ui/voxel';

/** The previews are drawn at half scale: a 2 dp voxel. */
const MINI_V = VOXEL / 2;
/** Blocks stay key-shaped however wide the swatch is. */
const MINI_BLOCK = { maxWidth: 28, maxHeight: 32 };
const SWATCH_HEIGHT = 80;
/** The selection ring sits one voxel outside the preview. */
const RING_GAP = VOXEL;

interface Option {
  value: ColorwaySetting;
  name: string;
  about: string;
  /** Two colourways shown split for "match system". */
  preview: Colorway[];
}

const OPTIONS: Option[] = [
  ...COLORWAY_LIST.map((c) => ({ value: c.id, name: c.name, about: c.about, preview: [c] })),
  { value: 'system', name: 'Match system', about: 'Paper in light mode, Graphite in dark mode.', preview: [COLORWAYS.paper, COLORWAYS.graphite] },
];

export function ColorwayPicker({ value, onChange }: { value: ColorwaySetting; onChange: (v: ColorwaySetting) => void }) {
  const { compact, width } = useScreen();
  const columns = compact && width < 520 ? 2 : 4;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Colourway" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {OPTIONS.map((o) => (
        <View key={o.value} style={{ width: `${100 / columns - 3}%`, flexGrow: 1 }}>
          <Swatch
            option={o}
            selected={o.value === value}
            onPress={() => {
              if (o.value !== value) haptics.tick();
              onChange(o.value);
            }}
          />
        </View>
      ))}
    </View>
  );
}

function Swatch({ option, selected, onPress }: { option: Option; selected: boolean; onPress: () => void }) {
  const cw = useColorway();
  return (
    <Press
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${option.name}. ${option.about}`}
      scaleTo={0.95}
      style={{ gap: 10, padding: RING_GAP + VOXEL }}
    >
      <View style={{ height: SWATCH_HEIGHT, gap: VOXEL }}>
        {selected ? <Ring steps={2} color={cw.focus} gap={RING_GAP} /> : null}
        {option.preview.map((c) => (
          <MiniPlate key={c.id} colorway={c} />
        ))}
      </View>
      <View style={{ gap: 1, paddingHorizontal: 2 }}>
        <Text variant="label" weight="semibold">
          {option.name}
        </Text>
        <Text variant="caption" tone="dim" numberOfLines={3}>
          {option.about}
        </Text>
      </View>
    </Press>
  );
}

/** That colourway's case holding a sunken plate with one tiny block in each cap tone. */
function MiniPlate({ colorway }: { colorway: Colorway }) {
  return (
    <View style={{ flex: 1, padding: MINI_V * 2 }}>
      <Shape steps={2} v={MINI_V} color={colorway.case} />
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: MINI_V * 2, padding: MINI_V * 2, paddingTop: MINI_V * 3 }}>
        <SunkenFace color={colorway.plate} lip={colorway.lip} v={MINI_V} lipDepth={MINI_V} />
        {CAP_COLORS.map((cap) => (
          <View key={cap} style={{ flex: 1, height: '100%', ...MINI_BLOCK }}>
            <RaisedFace tone={colorway.caps[cap]} v={MINI_V} depth={MINI_V * 2} shadow={colorway.shadow} />
          </View>
        ))}
      </View>
    </View>
  );
}
