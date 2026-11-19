/**
 * The deck: a header (pages, computer, Edit, settings) over a sunken plate of keys.
 * Pages swipe; Edit lifts the keys so they can be changed, added, dragged and removed;
 * holding a key opens a menu. When the computer drops, the keys power down.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Dimensions, type LayoutChangeEvent, View } from 'react-native';
import { useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AccountView } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { sounds } from '../../lib/sounds';
import { connection } from '../../net/connection';
import { useLive } from '../../state/live';
import { type Deck, type DeckKey, MAX_SLOTS, type Page, newId } from '../../state/model';
import { entryFor, needsRepair, useActiveComputer, useActiveDeck, useStore } from '../../state/store';
import { withAccountKeys } from '../../state/templates';
import { useUi } from '../../state/ui';
import { springs } from '../../theme/motion';
import { ContextMenu, type MenuItem, type Rect } from '../../ui/ContextMenu';
import { PrimaryButton } from '../../ui/controls';
import { Keycap } from '../../ui/Keycap';
import { Panel, PANEL_FRONT, Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { KeyInspectorPane, KeyInspectorSheet } from '../edit/KeyInspector';
import { PageSettingsSheet } from '../edit/PageSettingsSheet';
import { ComputerSheet } from '../settings/ComputerSheet';
import { SettingsSheet } from '../settings/SettingsSheet';
import { Fill, HeaderAccentButton, HeaderButton, headerMetrics } from './HeaderButton';
import { MoveKeySheet } from './MoveKeySheet';
import { otpFaces } from './OtpFace';
import { OutputSheet } from './OutputSheet';
import { PageGrid } from './PageGrid';
import { PageTabs } from './PageTabs';
import { Pager } from './Pager';
import { type HeaderRoom, pillDotOnly } from './headerRoom';
import { StatusPill } from './StatusPill';
import { useTwoFaPage } from './twoFaPage';
import { typeOtpCode } from './typeOtp';
import { useAddAccount } from './useAddAccount';
import { afterEditUnlock, mustLeaveEditing } from './editGate';
import { VaultControls } from './VaultChip';

interface KeyRef {
  pageId: string;
  index: number;
}

interface MenuState extends KeyRef {
  rect: Rect;
  key: DeckKey;
}

/** Where a key with this id sits in the deck, if anywhere. */
function findKey(deck: Deck | null, id: string | null): KeyRef | null {
  if (!deck || !id) return null;
  for (const page of deck.pages) {
    const index = page.slots.findIndex((k) => k?.id === id);
    if (index >= 0) return { pageId: page.id, index };
  }
  return null;
}

const clampIndex = (i: number, count: number) => Math.max(0, Math.min(Math.max(0, count - 1), i));

/** Widest the computer's block grows with a long name before ending it in an ellipsis. */
const PILL_MAX_PHONE = 200;
const PILL_MAX_TABLET = 320;

/** How long keys stay hidden after the window changes if the plate is never measured again. */
const PLATE_SETTLE_MS = 2000;

/** A page shows the vault controls when it is a 2FA page or holds a 2FA key. */
function hasOtp(page: Page | undefined): boolean {
  return !!page && (!!page.otp || page.slots.some((k) => !!k?.otp));
}

export function DeckScreen() {
  const computer = useActiveComputer();
  const deck = useActiveDeck();
  if (!computer) return null;
  if (!deck || deck.pages.length === 0) return <SettingUp name={computer.name} />;
  return <Deck key={computer.agentId} agentId={computer.agentId} name={computer.name} deck={deck} />;
}

function Deck({ agentId, name, deck }: { agentId: string; name: string; deck: Deck }) {
  const cw = useColorway();
  const screen = useScreen();
  const insets = useSafeAreaInsets();
  const { compact, wide } = screen;
  // A phone held upright stacks the header in two rows; on its side the height is short, so the
  // header takes one row, as on a tablet, and the keys get the height.
  const twoRowHeader = compact && !screen.landscape;
  const m = headerMetrics(compact);

  const computer = useActiveComputer();
  const platform = computer?.platform ?? 'macos';
  const settings = useStore((s) => s.settings);
  const storedIndex = useStore((s) => entryFor(s.pageIndex, agentId) ?? 0);
  const status = useLive((s) => s.status);
  const frontAppId = useLive((s) => s.focus?.appId ?? null);
  const vault = useVault();
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  useTwoFaPage(agentId, deck, vault.status, vault.accounts);

  const pages = deck.pages;
  const index = clampIndex(storedIndex, pages.length);

  const pos = useSharedValue(index);
  const target = useSharedValue(index);
  // The plate's size and the window it was measured in: after a rotation the window changes first and
  // the plate is measured a moment later, so keys sized for the old plate would spill out of it.
  const [plate, setPlate] = useState({ width: 0, height: 0, window: '' });
  const windowKey = `${screen.width}x${screen.height}`;
  const [settledWindow, setSettledWindow] = useState(windowKey);

  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moving, setMoving] = useState<KeyRef & { label: string } | null>(null);
  const [pageOptions, setPageOptions] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showComputers, setShowComputers] = useState(false);

  const deckRef = useRef(deck);
  deckRef.current = deck;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const goTo = useCallback(
    (i: number) => {
      const to = clampIndex(i, deckRef.current.pages.length);
      // The slide starts first, so the re-render the new index causes runs while it moves.
      target.value = to;
      pos.value = withSpring(to, springs.smooth);
      useStore.getState().setPageIndex(agentId, to);
    },
    [agentId, pos, target],
  );

  // Pages removed or reordered elsewhere: keep the stored index and the pager in range.
  useEffect(() => {
    if (storedIndex !== index) useStore.getState().setPageIndex(agentId, index);
    if (target.value !== index) {
      target.value = index;
      pos.value = withSpring(index, springs.smooth);
    }
  }, [agentId, index, storedIndex, pos, target]);

  // Bring a page forward when its linked app comes to the front on the computer.
  useEffect(() => {
    if (!settings.autoSwitch || editingRef.current || !frontAppId) return;
    const found = deckRef.current.pages.findIndex((p) => p.focusApp?.appId === frontAppId);
    if (found >= 0 && found !== target.value) goTo(found);
  }, [frontAppId, settings.autoSwitch, goTo, target]);

  const selected = findKey(deck, editing ? selectedId : null);
  // A selection that no longer exists (removed, undone elsewhere) is dropped.
  useEffect(() => {
    if (selectedId && !findKey(deck, selectedId)) setSelectedId(null);
  }, [deck, selectedId]);

  const lastSelected = useRef<KeyRef | null>(null);
  if (selected) lastSelected.current = selected;

  const stopEditing = useCallback(() => {
    setEditing(false);
    setSelectedId(null);
  }, []);

  /** Runs a change to the deck's keys once app lock (if on) has been passed; see editGate.ts. */
  const guarded = useCallback((change: () => void) => {
    void afterEditUnlock(vaultRef.current.requireUnlock, change, (message) =>
      useLive.getState().showToast({ tone: 'info', title: 'The deck stays as it is', detail: message }),
    );
  }, []);
  // Page settings can be open outside edit mode (a long press on a tab), so they close on lock too.
  const leaveEditing = mustLeaveEditing(editing || pageOptions !== null, vault);
  useEffect(() => {
    if (!leaveEditing) return;
    stopEditing();
    setPageOptions(null);
  }, [leaveEditing, stopEditing]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menu) {
        setMenu(null);
        return true;
      }
      if (selectedId) {
        setSelectedId(null);
        return true;
      }
      if (editing) {
        stopEditing();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [menu, selectedId, editing, stopEditing]);

  const removeKey = useCallback(
    (pageId: string, index: number) => {
      const p = deckRef.current.pages.find((x) => x.id === pageId);
      const key = p?.slots[index];
      if (!p || !key) return;
      haptics.tick();
      useStore.getState().setKey(agentId, pageId, index, null);
      if (selectedId === key.id) setSelectedId(null);
      useLive.getState().showToast({
        tone: 'info',
        title: `Removed ${key.label || 'the key'}`,
        action: {
          label: 'Undo',
          run: () => {
            const now = entryFor(useStore.getState().decks, agentId)?.pages.find((x) => x.id === pageId);
            if (!now) return;
            const at = now.slots[index] === null ? index : now.slots.indexOf(null);
            if (at >= 0) useStore.getState().setKey(agentId, pageId, at, key);
            else if (now.slots.length < MAX_SLOTS) {
              useStore.getState().resizePage(agentId, pageId, now.slots.length + 1);
              useStore.getState().setKey(agentId, pageId, now.slots.length, key);
            }
          },
        },
      });
    },
    [agentId, selectedId],
  );

  const duplicateKey = useCallback(
    (pageId: string, index: number) => {
      const p = deckRef.current.pages.find((x) => x.id === pageId);
      const key = p?.slots[index];
      if (!p || !key) return;
      const copy: DeckKey = { ...key, id: newId('k') };
      const after = p.slots.findIndex((k, i) => i > index && k === null);
      const anywhere = p.slots.indexOf(null);
      const at = after >= 0 ? after : anywhere;
      if (at >= 0) {
        useStore.getState().setKey(agentId, pageId, at, copy);
      } else if (p.slots.length < MAX_SLOTS) {
        useStore.getState().resizePage(agentId, pageId, p.slots.length + 1);
        useStore.getState().setKey(agentId, pageId, p.slots.length, copy);
      } else {
        useLive.getState().showToast({ tone: 'info', title: 'This page is full', detail: `A page holds up to ${MAX_SLOTS} keys.` });
        return;
      }
      haptics.tick();
    },
    [agentId],
  );

  const onKeyPress = useCallback(
    (pageId: string, i: number) => {
      const p = deckRef.current.pages.find((x) => x.id === pageId);
      const key = p?.slots[i];
      if (!p || !key) return;
      if (editingRef.current) {
        haptics.tick();
        sounds.tick();
        setSelectedId(key.id);
        return;
      }
      haptics.press();
      if (key.otp) void typeOtpCode(key, vaultRef.current, name);
      else void connection.runKey(key, p);
    },
    [name],
  );

  // New accounts from an empty spot on a 2FA page land in that spot (and the ones after it).
  const addTarget = useRef<{ pageId: string; index: number } | null>(null);
  const startAddAccount = useAddAccount((added: AccountView[]) => {
    const target = addTarget.current;
    addTarget.current = null;
    if (!target) return;
    const { updatePage } = useStore.getState();
    let left = 0;
    updatePage(agentId, target.pageId, (p) => {
      const placed = withAccountKeys(p, added, target.index);
      left = placed.left;
      return placed.page;
    });
    if (left > 0) {
      useLive
        .getState()
        .showToast({
          tone: 'info',
          title: 'This page is full',
          detail: `${left === 1 ? 'One account' : `${left} accounts`} did not fit. A page holds up to ${MAX_SLOTS} keys; add them on another page.`,
        });
    }
  });
  const onAddAccount = useCallback(
    (pageId: string, i: number) => {
      haptics.tick();
      guarded(() => {
        addTarget.current = { pageId, index: i };
        startAddAccount();
      });
    },
    [startAddAccount, guarded],
  );

  const onKeyMenu = useCallback(
    (i: number, rect: Rect) => {
      const p = deckRef.current.pages[clampIndex(entryFor(useStore.getState().pageIndex, agentId) ?? 0, deckRef.current.pages.length)];
      const key = p?.slots[i];
      if (!p || !key) return;
      setMenu({ pageId: p.id, index: i, rect, key });
    },
    [agentId],
  );

  const onSocketPress = useCallback(
    (pageId: string, i: number) => {
      haptics.tick();
      guarded(() => {
        const key: DeckKey = { id: newId('k'), label: '', icon: { kind: 'none' }, color: 'alpha', action: null };
        useStore.getState().setKey(agentId, pageId, i, key);
        setSelectedId(key.id);
      });
    },
    [agentId, guarded],
  );

  const addPage = () => {
    const id = useStore.getState().addPage(agentId, `Page ${deckRef.current.pages.length + 1}`);
    const at = entryFor(useStore.getState().decks, agentId)?.pages.findIndex((p) => p.id === id) ?? -1;
    if (at >= 0) goTo(at);
    setPageOptions(id);
  };

  const menuItems: MenuItem[] = menu
    ? [
        {
          label: 'Edit key',
          icon: 'pencil',
          onSelect: () =>
            guarded(() => {
              setEditing(true);
              setSelectedId(menu.key.id);
            }),
        },
        { label: 'Duplicate', icon: 'copy', onSelect: () => guarded(() => duplicateKey(menu.pageId, menu.index)) },
        ...(pages.length > 1
          ? [
              {
                label: 'Move to page',
                icon: 'arrow-right-box' as const,
                onSelect: () => setMoving({ pageId: menu.pageId, index: menu.index, label: menu.key.label }),
              },
            ]
          : []),
        { label: 'Remove', icon: 'trash', destructive: true, onSelect: () => removeKey(menu.pageId, menu.index) },
      ]
    : [];

  const dimmed = status !== 'online';
  const showSublegend = settings.sublegends && !compact;
  const onPlateLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const shown = Dimensions.get('window');
    const window = `${shown.width}x${shown.height}`;
    setPlate((p) => (p.width === width && p.height === height && p.window === window ? p : { width, height, window }));
  };
  // Keys show once the plate is measured for this window. Should no new measure come (the plate kept
  // its size), they show anyway after a moment.
  useEffect(() => {
    const timer = setTimeout(() => setSettledWindow(windowKey), PLATE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [windowKey]);
  const plateCurrent = plate.window === windowKey || settledWindow === windowKey;

  const pagePad = compact ? 12 : 20;
  const gridW = Math.max(0, plate.width - pagePad * 2);
  const gridH = Math.max(0, plate.height - pagePad * 2);

  // A 2FA page before there is a vault says what it is for; the deck's refusal panel stands alone.
  const offerSetup = vault.status === 'none' && status !== 'unauthorized';
  const renderPage = useCallback(
    (i: number, current: boolean) => {
      const p = deckRef.current.pages[i];
      if (!p) return null;
      const grid = (
        <PageGrid
          agentId={agentId}
          page={p}
          width={gridW}
          height={gridH}
          editing={editing}
          current={current}
          selectedId={selectedId}
          dimmed={dimmed}
          platform={platform}
          showSublegend={showSublegend}
          onKeyPress={onKeyPress}
          onKeyMenu={onKeyMenu}
          onKeyRemove={removeKey}
          onSocketPress={onSocketPress}
          onAddAccount={onAddAccount}
        />
      );
      if (!p.otp || !offerSetup) return grid;
      // Its empty spots would all say "Add account" around the panel: the plate shows just the panel.
      return (
        <View style={{ width: gridW, height: gridH }}>
          <TwoFaSetup tight={gridH < TIGHT_PLATE} />
        </View>
      );
    },
    // `deck` is listed so pages re-render when their keys change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, deck, gridW, gridH, editing, selectedId, dimmed, platform, showSublegend, onKeyPress, onKeyMenu, removeKey, onSocketPress, onAddAccount, offerSetup],
  );

  // The one-row header: every control keeps its size and only the page tabs give up width; the
  // computer's block drops its name, keeping its light, before the current tab is cut (headerRoom).
  const pillMax = compact ? PILL_MAX_PHONE : PILL_MAX_TABLET;
  const headRoom = useRef<HeaderRoom>({ tabs: 0, need: 0, fill: 0, full: 0 });
  const [pillDot, setPillDot] = useState(false);
  const pillDotRef = useRef(pillDot);
  pillDotRef.current = pillDot;
  const decidePill = useCallback(() => {
    const dot = pillDotOnly(headRoom.current, pillDotRef.current, m.control);
    if (dot !== null) setPillDot(dot);
  }, [m.control]);
  const onTabsRoom = useCallback(
    (width: number, need: number) => {
      headRoom.current.tabs = width;
      headRoom.current.need = need;
      decidePill();
    },
    [decidePill],
  );
  const onFillWidth = useCallback(
    (width: number) => {
      headRoom.current.fill = width;
      decidePill();
    },
    [decidePill],
  );
  const onPillWidth = useCallback(
    (width: number) => {
      headRoom.current.full = width;
      decidePill();
    },
    [decidePill],
  );
  useEffect(() => {
    // Two rows give the name its own row; a phone that turns upright again shows it.
    if (twoRowHeader) setPillDot(false);
    if (compact) headRoom.current.fill = 0;
  }, [twoRowHeader, compact]);

  // VaultControls draws nothing until there is a vault.
  const vaultShown = hasOtp(pages[index]) && (vault.status === 'open' || vault.status === 'locked');
  // In one row the computer's name always follows the tabs; in two rows, Add page or the vault's controls may.
  const tabsBeforeBlock = compact && (!twoRowHeader || editing || vaultShown);
  const tabs = (
    <PageTabs
      pages={pages}
      index={index}
      pos={pos}
      onSelect={goTo}
      onOptions={(i) => {
        const p = pages[i];
        if (!p) return;
        // A long press opens page settings outside edit mode too; they change the page's folder,
        // its linked app and its keys (Make 2FA page), so they ask for the same unlock as editing.
        if (editing) setPageOptions(p.id);
        else guarded(() => setPageOptions(p.id));
      }}
      editing={editing}
      compact={compact}
      stretch={twoRowHeader}
      grow={compact}
      frontAppId={frontAppId}
      beforeBlock={tabsBeforeBlock}
      onRoom={twoRowHeader ? undefined : onTabsRoom}
    />
  );
  const addPageButton = editing ? (
    <HeaderButton label="Add page" icon="plus" iconOnly compact={compact} onPress={addPage} />
  ) : null;
  const editButton = editing ? (
    <HeaderAccentButton label="Done" compact={compact} onPress={stopEditing} />
  ) : (
    <HeaderButton
      label="Edit"
      compact={compact}
      onPress={() => {
        haptics.tick();
        guarded(() => setEditing(true));
      }}
    />
  );
  const showComputerSheet = useCallback(() => setShowComputers(true), []);
  const statusPill = <StatusPill name={name} compact={compact} dotOnly={pillDot} onPress={showComputerSheet} />;
  const settingsButton = <HeaderButton label="Settings" icon="settings-cog" iconOnly compact={compact} onPress={() => setShowSettings(true)} />;
  const vaultControls = vaultShown ? <VaultControls compact={compact} /> : null;

  const sidePad = { paddingLeft: insets.left + m.margin, paddingRight: insets.right + m.margin };
  const paneOpen = wide && editing && !!selected;
  const vaultCovers = useAuthUi((s) => s.surface === 'vault');

  return (
    <View
      style={{ flex: 1, backgroundColor: cw.case, paddingTop: insets.top + (compact ? 12 : m.margin) }}
      // The vault screen covers the deck; screen readers skip what is under it.
      importantForAccessibility={vaultCovers ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={vaultCovers}
    >
      {twoRowHeader ? (
        <>
          <View style={[{ flexDirection: 'row', alignItems: 'center', gap: m.gap, height: m.control + 4 }, sidePad]}>
            {statusPill}
            <Fill />
            {editButton}
            {settingsButton}
          </View>
          <View style={[{ flexDirection: 'row', alignItems: 'center', gap: m.gap, marginTop: m.gap }, sidePad]}>
            {tabs}
            {addPageButton}
            {vaultControls}
          </View>
        </>
      ) : (
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: m.gap, height: m.control + 4 }, sidePad]}>
          {tabs}
          {addPageButton}
          {/* On a phone the tabs bar takes the free width, so every control is one gap apart. */}
          {compact ? null : <Fill onWidth={onFillWidth} />}
          {vaultControls}
          {/* Only the page tabs give up width; the computer's name goes first, leaving its light. */}
          <View style={{ flexShrink: 0, maxWidth: pillMax }}>{statusPill}</View>
          {editButton}
          {settingsButton}
          {/* The computer's block with its name, unseen, to know how wide it would be. */}
          <View
            pointerEvents="none"
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ position: 'absolute', left: 0, top: 0, opacity: 0, maxWidth: pillMax }}
            onLayout={(e) => onPillWidth(e.nativeEvent.layout.width)}
          >
            <StatusPill name={name} compact={compact} onPress={showComputerSheet} />
          </View>
        </View>
      )}

      <View
        style={[
          { flex: 1, flexDirection: 'row', gap: m.margin, marginTop: m.gap, paddingBottom: insets.bottom + m.margin },
          sidePad,
        ]}
      >
        <Well color={cw.plate} steps={2} style={{ flex: 1 }}>
          {/* Clipped so neighbouring pages never show outside the plate. */}
          <View style={{ flex: 1, overflow: 'hidden' }} onLayout={onPlateLayout}>
            {gridW > 0 && gridH > 0 ? (
              <View style={{ position: 'absolute', left: pagePad, top: pagePad, opacity: plateCurrent ? 1 : 0 }}>
                <Pager
                  count={pages.length}
                  index={index}
                  pos={pos}
                  target={target}
                  width={gridW}
                  height={gridH}
                  onIndex={goTo}
                  pageKey={(i) => pages[i]?.id ?? String(i)}
                  renderPage={renderPage}
                />
              </View>
            ) : null}
            {status === 'unauthorized' ? <Unauthorized agentId={agentId} name={name} repair={!!computer && needsRepair(computer)} /> : null}
          </View>
        </Well>
        {paneOpen && selected ? (
          <KeyInspectorPane agentId={agentId} pageId={selected.pageId} index={selected.index} onClose={() => setSelectedId(null)} />
        ) : null}
      </View>

      {!wide && lastSelected.current ? (
        <KeyInspectorSheet
          visible={editing && !!selected}
          agentId={agentId}
          pageId={(selected ?? lastSelected.current).pageId}
          index={(selected ?? lastSelected.current).index}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <ContextMenu
        anchor={menu?.rect ?? null}
        items={menuItems}
        onClose={() => setMenu(null)}
        preview={
          menu ? (
            <Keycap
              width={menu.rect.width}
              height={menu.rect.height}
              tone={cw.caps[menu.key.color] ?? cw.caps.alpha}
              label={menu.key.label}
              icon={menu.key.icon}
              {...(menu.key.otp ? otpFaces(menu.key, cw.caps[menu.key.color] ?? cw.caps.alpha, menu.rect.width, menu.rect.height, true) : null)}
            />
          ) : null
        }
      />

      {moving ? (
        <MoveKeySheet
          visible
          keyLabel={moving.label}
          pages={pages}
          fromPageId={moving.pageId}
          onClose={() => setMoving(null)}
          onPick={(toPageId) => {
            const ok = useStore.getState().moveKeyToPage(agentId, moving.pageId, moving.index, toPageId);
            const to = deckRef.current.pages.find((p) => p.id === toPageId);
            setMoving(null);
            useLive.getState().showToast(
              ok
                ? { tone: 'ok', title: `Moved to ${to?.name || 'the page'}` }
                : { tone: 'info', title: `${to?.name || 'That page'} is full`, detail: `A page holds up to ${MAX_SLOTS} keys.` },
            );
          }}
        />
      ) : null}

      {pageOptions ? (
        <PageSettingsSheet visible agentId={agentId} pageId={pageOptions} onClose={() => setPageOptions(null)} />
      ) : null}
      <SettingsSheet visible={showSettings} onClose={() => setShowSettings(false)} />
      <ComputerSheet visible={showComputers} onClose={() => setShowComputers(false)} />
      <OutputSheet />
    </View>
  );
}

/**
 * The computer refused this device, or it was paired before the connection was encrypted:
 * ask to pair again, over the powered-down keys.
 */
function Unauthorized({ agentId, name, repair }: { agentId: string; name: string; repair: boolean }) {
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Panel style={{ maxWidth: 460, padding: 24, paddingBottom: 24 + PANEL_FRONT, gap: 16 }}>
        <Text variant="heading">{name} needs pairing again</Text>
        <Text tone="dim">
          {repair
            ? 'AuthDeck now encrypts the connection to your computer, so each device pairs once more. Your pages stay as they are.'
            : 'The computer no longer accepts this device. Pair again to get your keys back; your pages stay as they are.'}
        </Text>
        <PrimaryButton label="Pair again" icon="link" onPress={() => useUi.getState().startPairing(null, agentId, repair ? null : 'unpaired')} />
      </Panel>
    </View>
  );
}

/** Below this plate height (a small phone on its side) the setup panel drops its outer room. */
const TIGHT_PLATE = 280;

/** A 2FA page while there is no vault: what the page is for, and the authenticator's setup. */
function TwoFaSetup({ tight }: { tight: boolean }) {
  const pad = tight ? 16 : 24;
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: tight ? 0 : 24 }}>
      <Panel style={{ maxWidth: 460, padding: pad, paddingBottom: pad + PANEL_FRONT, gap: tight ? 10 : 16 }}>
        <Text variant="heading">2FA codes on your deck</Text>
        <Text tone="dim">Keep your two-factor codes here and tap a key to type one on your computer.</Text>
        <PrimaryButton label="Set up" icon="lock" onPress={() => useAuthUi.getState().open('intro')} />
      </Panel>
    </View>
  );
}

/** Paired, but no deck yet: one is built from the computer's apps when it connects. */
function SettingUp({ name }: { name: string }) {
  const cw = useColorway();
  const insets = useSafeAreaInsets();
  const status = useLive((s) => s.status);
  const waiting = status !== 'online';
  return (
    <View style={{ flex: 1, backgroundColor: cw.case, alignItems: 'center', justifyContent: 'center', padding: 24, paddingTop: insets.top + 24 }}>
      <Panel style={{ maxWidth: 480, padding: 24, paddingBottom: 24 + PANEL_FRONT, gap: 12 }}>
        <Text variant="heading">{waiting ? `Waiting for ${name}` : 'Setting up your deck'}</Text>
        <Text tone="dim">
          {waiting
            ? `Your starter pages are built from the apps on ${name}. Make sure the AuthDeck agent is running there.`
            : `Building starter pages from the apps on ${name}.`}
        </Text>
      </Panel>
    </View>
  );
}
