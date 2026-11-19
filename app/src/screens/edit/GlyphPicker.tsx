/** Searchable grid of every pixel symbol, with a few coding favourites first. */
import { useEffect, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { PressBlock } from '../../ui/controls';
import { Glyph, type GlyphName, resolveGlyph } from '../../ui/Icon';
import { GLYPH_NAMES } from '../../ui/pixelIcons';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { searchable } from './actionModel';
import { SearchField } from './AppPicker';
import { Notice } from './parts';

const TILE = 64;
const GAP = 8;

const SUGGESTED: GlyphName[] = [
  'terminal',
  'code',
  'braces',
  'git-branch',
  'git-pull-request',
  'git-merge',
  'git-commit',
  'github',
  'play',
  'bug',
  'debug',
  'test-tube',
  'zap',
  'refresh',
  'search',
  'script',
  'database',
  'server',
  'docker',
  'cloud',
  'globe',
  'folder',
  'file-text',
  'package',
  'tools',
  'save',
  'copy',
  'clipboard',
  'undo',
  'redo',
  'eye',
  'layout',
  'text-colums',
  'message',
  'robot',
  'sparkles',
  'upload',
  'download',
  'lock',
  'monitor',
];
const SUGGESTED_SET = new Set<GlyphName>(SUGGESTED);

/** Glyph names that match the query, favourites first when there is no query. */
function matchGlyphs(query: string): GlyphName[] {
  const q = searchable(query);
  if (!q) return [...SUGGESTED, ...GLYPH_NAMES.filter((g) => !SUGGESTED_SET.has(g))];
  const starts: GlyphName[] = [];
  const contains: GlyphName[] = [];
  for (const g of GLYPH_NAMES) {
    const s = searchable(g);
    if (s.startsWith(q)) starts.push(g);
    else if (s.includes(q)) contains.push(g);
  }
  return [...starts, ...contains];
}

/** "git-pull-request" -> "git pull request", for screen readers. */
function spokenName(glyph: GlyphName): string {
  return glyph.replace(/-/g, ' ');
}

export function GlyphPickerSheet({
  visible,
  onClose,
  onPick,
  selected,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (name: GlyphName) => void;
  /** The key's saved symbol name, which may come from an older icon set. */
  selected?: string;
}) {
  const cw = useColorway();
  const chosen = selected === undefined ? undefined : resolveGlyph(selected);
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState(0);
  const glyphs = useMemo(() => matchGlyphs(query), [query]);
  // Leave room for the solid shadow of the last column, which the list would clip.
  const room = width - VOXEL;
  const columns = Math.max(1, Math.floor((room + GAP) / (TILE + GAP)));
  const tileW = (room - GAP * (columns - 1)) / columns;

  useEffect(() => {
    if (visible) setQuery('');
  }, [visible]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Choose a symbol"
      subtitle={`${GLYPH_NAMES.length} symbols`}
      tall
      noScroll
      maxWidth={760}
    >
      <View style={{ flex: 1, gap: 14 }}>
        <View style={{ flexDirection: 'row' }}>
          <SearchField value={query} onChange={setQuery} placeholder="Search symbols, like git or play" />
        </View>
        {glyphs.length === 0 ? (
          <Notice title={`No symbols match “${query}”`} detail="Try a simpler word, such as file, arrow or terminal." />
        ) : null}
        <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {width > 0 ? (
            <FlatList
              key={columns}
              data={glyphs}
              numColumns={columns}
              keyExtractor={(g) => g}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              initialNumToRender={columns * 8}
              maxToRenderPerBatch={columns * 6}
              windowSize={7}
              columnWrapperStyle={columns > 1 ? { gap: GAP } : undefined}
              contentContainerStyle={{ gap: GAP, paddingBottom: 12 }}
              getItemLayout={(_, i) => ({ length: TILE + GAP, offset: (TILE + GAP) * i, index: i })}
              accessibilityLabel="Symbols"
              renderItem={({ item }) => {
                const on = item === chosen;
                const tone = on ? cw.caps.a : cw.control;
                return (
                  <PressBlock
                    tone={tone}
                    onPress={() => {
                      haptics.tick();
                      onPick(item);
                      onClose();
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={spokenName(item)}
                    style={{ width: tileW, height: TILE }}
                    contentStyle={{ alignItems: 'center', justifyContent: 'center', paddingBottom: VOXEL }}
                  >
                    <Glyph name={item} size={24} color={on ? cw.caps.a.legend : cw.text} />
                  </PressBlock>
                );
              }}
            />
          ) : null}
        </View>
        {query ? null : (
          <Text variant="caption" tone="faint">
            Coding favourites come first. Search to find any of the others.
          </Text>
        )}
      </View>
    </Sheet>
  );
}
