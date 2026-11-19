/** Choose one of the apps installed on the computer: a searchable grid with the apps' own icons. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, type ListViewToken, TextInput, View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { connection } from '../../net/connection';
import type { AppEntry } from '../../protocol';
import { useLive } from '../../state/live';
import { fonts } from '../../theme/type';
import { GhostButton, Press, PrimaryButton } from '../../ui/controls';
import { AppIcon, Glyph } from '../../ui/Icon';
import { SHORT_WINDOW, Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Ring, Shape } from '../../ui/voxel';
import { searchable } from './actionModel';
import { InputFrame, Notice, useAppName, useEnv, useOnline } from './parts';

/** Corner steps of an app tile, which is as big as a key. */
const TILE_STEPS = 2;
const EMPTY_ICON = 36;

const TILE_MIN_W = 112;
const TILE_H = 132;
/**
 * Below SHORT_WINDOW (a phone on its side) the tiles are shorter and the computer's name is
 * left out, so a full row of apps fits between the search field and the buttons.
 */
const SHORT_TILE_H = 92;

function useTileHeight(): number {
  return useScreen().height < SHORT_WINDOW ? SHORT_TILE_H : TILE_H;
}
const TILE_GAP = 8;
const VIEWABILITY = { itemVisiblePercentThreshold: 10 };

interface AppPickerProps {
  visible: boolean;
  onClose: () => void;
  onPick: (app: AppEntry) => void;
  title?: string;
  selectedId?: string;
}

function AppPickerSheet({ visible, onClose, onPick, title = 'Choose an app', selectedId }: AppPickerProps) {
  const { agentId, computerName } = useEnv();
  const apps = useLive((s) => s.apps);
  const appsError = useLive((s) => s.appsError);
  const online = useOnline(agentId);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | undefined>(selectedId);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setChosen(selectedId);
    setQuery('');
  }, [visible, selectedId]);

  const shown = useMemo(() => {
    const q = searchable(query);
    const list = apps ?? [];
    return q ? list.filter((a) => searchable(a.name).includes(q) || searchable(a.detail ?? '').includes(q)) : list;
  }, [apps, query]);
  const chosenApp = apps?.find((a) => a.id === chosen);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await connection.listApps(true);
    } finally {
      setRefreshing(false);
    }
  };

  const short = useScreen().height < SHORT_WINDOW;
  const subtitle = apps ? `${apps.length} ${apps.length === 1 ? 'app' : 'apps'} on ${computerName}` : `Apps installed on ${computerName}`;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      subtitle={short ? undefined : subtitle}
      tall
      noScroll
      maxWidth={980}
      footer={
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <GhostButton label="Cancel" onPress={onClose} />
          <PrimaryButton
            label={chosenApp ? `Use ${chosenApp.name}` : 'Use this app'}
            disabled={!chosenApp}
            onPress={() => {
              if (!chosenApp) return;
              haptics.tick();
              onPick(chosenApp);
              onClose();
            }}
          />
        </View>
      }
    >
      <View style={{ flex: 1, gap: short ? 8 : 14 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <SearchField value={query} onChange={setQuery} placeholder="Search apps" />
          <GhostButton
            label={refreshing ? 'Looking…' : 'Look again'}
            icon="refresh"
            small
            onPress={refresh}
            disabled={!online || refreshing}
          />
        </View>
        <AppListState online={online} hasApps={!!apps} error={appsError} computerName={computerName} />
        {apps ? <AppGrid apps={shown} chosen={chosen} onChoose={setChosen} query={query} /> : null}
      </View>
    </Sheet>
  );
}

function AppListState({
  online,
  hasApps,
  error,
  computerName,
}: {
  online: boolean;
  hasApps: boolean;
  error: string | null;
  computerName: string;
}) {
  const cw = useColorway();
  if (!online && !hasApps) {
    return (
      <Notice
        tone="warn"
        title={`Connect to ${computerName} to see its apps`}
        detail="AuthDeck keeps trying to reconnect. Check that the AuthDeck agent is running on the computer and that both are on the same network."
      />
    );
  }
  if (error) {
    return <Notice tone="fail" title="Could not read the app list" detail={`${error} Tap Look again to retry.`} />;
  }
  if (!hasApps) {
    return (
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 20 }} accessibilityLiveRegion="polite">
        <ActivityIndicator color={cw.textDim} />
        <Text tone="dim">Reading the apps on {computerName}…</Text>
      </View>
    );
  }
  if (!online) {
    return (
      <Notice
        tone="warn"
        title={`${computerName} is offline`}
        detail="This is the last list it sent. It updates when the computer reconnects."
      />
    );
  }
  return null;
}

function AppGrid({ apps, chosen, onChoose, query }: { apps: AppEntry[]; chosen?: string; onChoose: (id: string) => void; query: string }) {
  const [width, setWidth] = useState(0);
  const columns = Math.max(1, Math.floor((width + TILE_GAP) / (TILE_MIN_W + TILE_GAP)));
  const tileH = useTileHeight();

  // Fetch icons for what is on screen in one batch rather than one request per tile.
  const onViewable = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const visible = viewableItems.map((v) => v.item as AppEntry);
    const ids = visible.filter((a) => a.hasIcon).map((a) => a.id);
    if (ids.length) void connection.loadIcons(ids);
  }).current;

  if (apps.length === 0) {
    return (
      <Notice
        title={query ? `No apps match “${query}”` : 'No apps found'}
        detail={
          query ? 'Check the spelling, or tap Look again if you installed it just now.' : 'Tap Look again to search the computer once more.'
        }
      />
    );
  }
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <FlatList
          key={columns}
          data={apps}
          numColumns={columns}
          keyExtractor={(a) => a.id}
          accessibilityRole="list"
          accessibilityLabel="Apps"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          columnWrapperStyle={columns > 1 ? { gap: TILE_GAP } : undefined}
          contentContainerStyle={{ gap: TILE_GAP, paddingBottom: 12 }}
          getItemLayout={(_, i) => ({ length: tileH + TILE_GAP, offset: (tileH + TILE_GAP) * i, index: i })}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={VIEWABILITY}
          renderItem={({ item }) => (
            <AppTile
              app={item}
              width={(width - TILE_GAP * (columns - 1)) / columns}
              on={item.id === chosen}
              onPress={() => {
                if (item.id !== chosen) haptics.tick();
                onChoose(item.id);
              }}
            />
          )}
        />
      ) : null}
    </View>
  );
}

function AppTile({ app, width, on, onPress }: { app: AppEntry; width: number; on: boolean; onPress: () => void }) {
  const cw = useColorway();
  const tileH = useTileHeight();
  return (
    <Press
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={app.detail ? `${app.name}, ${app.detail}` : app.name}
      style={{ width, height: tileH, alignItems: 'center', justifyContent: 'center', gap: tileH < TILE_H ? 6 : 10, paddingHorizontal: 8 }}
    >
      {on ? (
        <>
          <Shape steps={TILE_STEPS} color={cw.surfaceAlt} />
          <Ring steps={TILE_STEPS} color={cw.focus} gap={0} />
        </>
      ) : null}
      <AppIcon appId={app.id} size={tileH < TILE_H ? 40 : 56} placeholderColor={cw.surfaceAlt} />
      <Text variant="label" weight="medium" center numberOfLines={2}>
        {app.name}
      </Text>
    </Press>
  );
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <InputFrame style={{ flex: 1, height: compact ? 48 : 54, gap: 10, paddingLeft: 14, paddingRight: 6 }}>
      <Glyph name="search" size={24} color={cw.textFaint} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={cw.textFaint}
        selectionColor={cw.focus}
        accessibilityLabel={placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={{ position: 'relative', flex: 1, alignSelf: 'stretch', color: cw.text, fontFamily: fonts.plex.regular, fontSize: compact ? 15 : 16 }}
      />
      {value ? (
        <Press onPress={() => onChange('')} accessibilityLabel="Clear search" hitSlop={8} style={{ padding: 8 }}>
          <Glyph name="close" size={24} color={cw.textDim} />
        </Press>
      ) : null}
    </InputFrame>
  );
}

/**
 * Shows the chosen app with a Choose/Change button that opens the picker.
 * Offline it still shows the saved app by name.
 */
export function AppChoice({
  appId,
  appName,
  emptyText,
  pickerTitle,
  onPick,
  onClear,
}: {
  appId?: string;
  appName?: string;
  emptyText: string;
  pickerTitle?: string;
  onPick: (app: AppEntry) => void;
  onClear?: () => void;
}) {
  const cw = useColorway();
  const [open, setOpen] = useState(false);
  const name = useAppName(appId, appName);
  const missing = useLive((s) => !!appId && !!s.apps && !s.apps.some((a) => a.id === appId));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50 }}>
        {appId ? (
          <AppIcon appId={appId} size={EMPTY_ICON} placeholderColor={cw.surfaceAlt} />
        ) : (
          <View style={{ width: EMPTY_ICON, height: EMPTY_ICON }}>
            <Ring steps={1} color={cw.textFaint} gap={0} />
          </View>
        )}
        <Text style={{ flex: 1 }} numberOfLines={1} tone={appId ? 'normal' : 'dim'}>
          {appId ? name : emptyText}
        </Text>
        {appId && onClear ? (
          <Press onPress={onClear} accessibilityLabel={`Remove ${name}`} hitSlop={6} style={{ padding: 10 }}>
            <Glyph name="close" size={24} color={cw.textDim} />
          </Press>
        ) : null}
        <GhostButton small label={appId ? 'Change' : 'Choose'} onPress={() => setOpen(true)} />
      </View>
      {missing ? (
        <Notice
          tone="warn"
          title={`${name} is not installed on this computer any more`}
          detail="Choose another app, or install it and tap Look again in the app list."
        />
      ) : null}
      <AppPickerSheet visible={open} onClose={() => setOpen(false)} onPick={onPick} selectedId={appId} title={pickerTitle} />
    </View>
  );
}
