import { useFonts } from 'expo-font';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { Component, type ReactNode, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedReaction, useAnimatedStyle } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useShallow } from 'zustand/react/shallow';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthHost } from './auth/AuthHost';
import { sounds } from './lib/sounds';
import { connection } from './net/connection';
import { sweepOrphanedIconCaches } from './net/iconCacheStorage';
import { parsePairLink } from './net/discovery';
import { computerLink } from './net/linkState';
import { DeckScreen } from './screens/deck/DeckScreen';
import { PairScreen } from './screens/pair/PairScreen';
import { STORAGE_WARNING, connectCanary, heldNotice, useConnectCanary } from './state/connectCanary';
import type { Computer } from './state/model';
import { iconCanary } from './state/iconCanary';
import { useLive } from './state/live';
import { launchScreen, useSavedStateLoad } from './state/savedStorage';
import { resetSavedDecksAndComputers, retryLoad, useStore } from './state/store';
import { useUi } from './state/ui';
import { COLORWAYS } from './theme/colorways';
import { fontAssets } from './theme/type';
import { GhostButton, LinkButton, PrimaryButton } from './ui/controls';
import { KeyWords } from './ui/KeyWords';
import { Text } from './ui/Text';
import { ToastHost } from './ui/Toast';
import { DepthProvider, useColorway, useDepth } from './ui/theme';
import { RaisedFace, VOXEL } from './ui/voxel';

const KEEP_AWAKE_TAG = 'authdeck';

export default function App() {
  // A font that fails to load falls back to the system font rather than holding the splash.
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const screen = launchScreen(fontsLoaded || !!fontError, useSavedStateLoad());
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <SafeAreaProvider>
        <DepthProvider>
          {screen === 'app' ? (
            <RecoverFromCrash>
              <Root />
            </RecoverFromCrash>
          ) : screen === 'recovery' ? (
            <SavedStateRecovery />
          ) : (
            <Splash />
          )}
        </DepthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Splash() {
  return <View style={{ flex: 1, backgroundColor: COLORWAYS.graphite.case }} />;
}

/**
 * Shown instead of the app when the saved decks and computers could not be read (state/
 * savedStorage.ts), which would otherwise leave the splash on screen for good. Nothing is written
 * over the saved value until the person resets it. There is no export here: AsyncStorage has no
 * way to read part of a value, so a value too large to read can't be read at all, and one that is
 * no longer JSON is no deck file the import could take.
 */
function SavedStateRecovery() {
  const cw = useColorway();
  const load = useSavedStateLoad();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    task().finally(() => setBusy(false));
  };
  const why = load.status === 'failed' && load.tooLarge ? 'They grew too large for this device to read back.' : 'The saved copy is damaged.';
  return (
    <View style={[styles.fill, styles.centered, { backgroundColor: cw.case }]}>
      <ScrollView contentContainerStyle={styles.crashBody}>
        <Text variant="title">Saved decks couldn't be loaded</Text>
        <Text tone="dim">{`AuthDeck couldn't read the decks, paired computers and settings saved on this device. ${why} They are left as they are until you choose what to do.`}</Text>
        <Text tone="dim">The 2FA vault is saved separately and is not affected.</Text>
        <PrimaryButton label="Try again" disabled={busy} onPress={() => run(retryLoad)} />
        <View style={styles.crashOption}>
          <Text tone="dim">
            Resetting deletes the saved decks, paired computers and settings on this device so AuthDeck can open. Pair your computers again
            afterwards; a deck you exported from Settings can be imported again.
          </Text>
          {confirming ? (
            <GhostButton label="Reset now" danger disabled={busy} onPress={() => run(resetSavedDecksAndComputers)} />
          ) : (
            <GhostButton label="Reset decks and computers" disabled={busy} onPress={() => setConfirming(true)} />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * The last line of defence: an error while drawing would otherwise close the app in a release
 * build. Shows a plain screen instead; "Try again" draws the app afresh from the saved state.
 * Saved state that crashes every time (something a computer sent) would trap the person here, so
 * the screen also offers ways out that keep the vault, decks and pairings: another computer, and
 * after a second crash, forgetting what the active computer sent for display. When that is not
 * enough, the active computer itself can be forgotten (the vault stays), which works even when it
 * is the only one.
 */
class RecoverFromCrash extends Component<{ children: ReactNode }, { failed: boolean; crashes: number }> {
  state = { failed: false, crashes: 0 };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.setState((s) => ({ crashes: s.crashes + 1 }));
  }

  private readonly retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return <CrashScreen crashedAgain={this.state.crashes >= CRASHES_BEFORE_CLEARING} onRetry={this.retry} />;
  }
}

/** Clearing a computer's cached display data is offered from the second crash on. */
const CRASHES_BEFORE_CLEARING = 2;

function CrashScreen({ crashedAgain, onRetry }: { crashedAgain: boolean; onRetry: () => void }) {
  const cw = useColorway();
  const active = useStore((s) => s.computers.find((c) => c.agentId === s.activeId) ?? null);
  const others = useStore(useShallow((s) => s.computers.filter((c) => c.agentId !== s.activeId)));
  const canSwitch = useStore((s) => s.computers.length > 1);
  const [clearing, setClearing] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);

  const clearActive = async () => {
    if (!active) return;
    setClearing(true);
    try {
      await connection.clearDisplayCache(active.agentId);
    } finally {
      setClearing(false);
      onRetry();
    }
  };
  const switchTo = (agentId: string) => {
    useStore.getState().setActive(agentId);
    onRetry();
  };
  const forgetActive = async () => {
    if (!active) return;
    setClearing(true);
    try {
      // Removing it also drops its deck and moves to another saved computer, or to pairing.
      await connection.forgetComputer(active.agentId);
    } finally {
      setClearing(false);
      onRetry();
    }
  };

  return (
    <View style={[styles.fill, styles.centered, { backgroundColor: cw.case }]}>
      <ScrollView contentContainerStyle={styles.crashBody}>
        <Text variant="title">Something went wrong</Text>
        <Text tone="dim">AuthDeck hit a problem drawing this screen. Your computers, keys and pages are saved.</Text>
        <PrimaryButton label="Try again" onPress={onRetry} />
        {crashedAgain && active ? (
          <View style={styles.crashOption}>
            <Text tone="dim">{`If it keeps happening, something ${active.name} sent may be damaged. This clears only the apps and icons AuthDeck saved from it; its keys, pages and pairing stay, and the 2FA vault is not touched.`}</Text>
            <GhostButton label="Clear this computer's cached apps and icons" disabled={clearing} onPress={() => void clearActive()} />
            <Text tone="dim">{`If that does not help, forget ${active.name}. Its keys and pages go with it and it has to be paired again; the 2FA vault is not touched.`}</Text>
            {confirmingForget ? (
              <GhostButton label={`Forget ${active.name} now`} danger disabled={clearing} onPress={() => void forgetActive()} />
            ) : (
              <GhostButton label="Forget this computer" disabled={clearing} onPress={() => setConfirmingForget(true)} />
            )}
          </View>
        ) : null}
        {canSwitch ? (
          <View style={styles.crashOption}>
            <Text tone="dim">Switch computer</Text>
            {others.map((c) => (
              <SwitchChoice key={c.agentId} computer={c} onPress={() => switchTo(c.agentId)} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * One computer to switch to: its whole name, wrapped rather than cut off, and its key words, so a
 * look-alike name can't pass for it.
 */
function SwitchChoice({ computer, onPress }: { computer: Computer; onPress: () => void }) {
  const link = computerLink(computer);
  return (
    <View style={{ gap: 6 }}>
      <Text weight="semibold">{computer.name}</Text>
      {link.kind === 'linked' ? (
        <KeyWords keyWords={link.keyWords} />
      ) : (
        <Text variant="caption" tone="faint">
          {link.title}
        </Text>
      )}
      <GhostButton small label="Use this computer" icon="arrow-bar-right" onPress={onPress} />
    </View>
  );
}

/**
 * Icons from a computer were drawing when AuthDeck last closed (state/iconCanary.ts): they show as
 * placeholders, and this says so once per launch with a way to clear them. Settings > Computers
 * offers the same while they stay hidden.
 */
let toldHiddenIcons = false;
async function tellHiddenIcons(): Promise<void> {
  if (toldHiddenIcons) return;
  toldHiddenIcons = true;
  const hidden = await iconCanary.check();
  const { computers } = useStore.getState();
  for (const agentId of hidden) {
    const computer = computers.find((c) => c.agentId === agentId);
    if (!computer) {
      // Forgotten since: nothing of it is drawn any more.
      await iconCanary.clear(agentId);
      continue;
    }
    useLive.getState().showToast({
      tone: 'fail',
      title: `Icons from ${computer.name} are hidden`,
      detail: 'AuthDeck closed while drawing them last time.',
      action: { label: 'Clear icons', run: () => void connection.clearIcons(agentId) },
    });
  }
}

/**
 * AuthDeck closed while connecting to these addresses on two launches in a row
 * (state/connectCanary.ts), so it leaves them alone until the person chooses. Connect releases them
 * and reconnects; Not now keeps them held, and the notice comes back when something needs one of
 * them (a key press, a pairing). Also says, once a launch, when the canary's notes could not be
 * saved: connections go ahead without them.
 */
function ConnectNotice() {
  const cw = useColorway();
  const insets = useSafeAreaInsets();
  const { held, noticeShown, storageWarning } = useConnectCanary(
    useShallow((s) => ({ held: s.held, noticeShown: s.noticeShown, storageWarning: s.storageWarning })),
  );
  const [busy, setBusy] = useState(false);
  const showHeld = noticeShown && held.length > 0;
  if (!showHeld && !storageWarning) return null;
  const connect = async () => {
    setBusy(true);
    try {
      await Promise.all(held.map((host) => connectCanary.release(host)));
    } finally {
      setBusy(false);
    }
    connection.wake();
  };
  return (
    <View pointerEvents="box-none" style={[styles.noticeLayer, { bottom: insets.bottom + 16 }]}>
      <View accessibilityRole="alert" style={styles.notice}>
        <RaisedFace tone={cw.float} steps={2} depth={2 * VOXEL} shadow={cw.shadow} />
        {storageWarning ? <Text variant="subhead">{STORAGE_WARNING}</Text> : null}
        {showHeld ? <Text variant="subhead">{heldNotice(held)}</Text> : null}
        <View style={styles.noticeButtons}>
          {showHeld ? (
            <>
              <View>
                <LinkButton label="Not now" onPress={() => connectCanary.hideNotice()} />
              </View>
              <PrimaryButton
                label="Connect"
                busy={busy}
                onPress={() => {
                  connectCanary.dismissStorageWarning();
                  void connect();
                }}
              />
            </>
          ) : (
            <PrimaryButton label="OK" onPress={() => connectCanary.dismissStorageWarning()} />
          )}
        </View>
      </View>
    </View>
  );
}

function Root() {
  const cw = useColorway();
  // Pairing never switches computers on its own, so a saved computer may not be the active one yet.
  const hasActive = useStore((s) => s.computers.some((c) => c.agentId === s.activeId));
  const pairing = useUi((s) => s.pairing);
  const keepAwake = useStore((s) => s.settings.keepAwake);
  const url = Linking.useLinkingURL();

  useEffect(() => connection.init(), []);
  useEffect(() => sounds.load(), []);
  useEffect(() => {
    void tellHiddenIcons();
    // Reads the connection canary's mark, so the notice shows even with no computer to connect to.
    void connectCanary.check();
  }, []);
  useEffect(() => {
    // Root mounts once the saved state has loaded, so the saved computers are known by now.
    // A sweep that fails leaves only space taken; the next launch sweeps again.
    sweepOrphanedIconCaches(() => new Set(useStore.getState().computers.map((c) => c.agentId))).catch(() => undefined);
  }, []);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(cw.case).catch(() => undefined);
  }, [cw.case]);

  useEffect(() => {
    if (!keepAwake) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    };
  }, [keepAwake]);

  // Pairing links from the system camera or another app: authdeck://pair?... The pairing screen
  // shows the computer the link names and pairs only after the person confirms it.
  useEffect(() => {
    if (!url) return;
    const link = parsePairLink(url);
    if (link) useUi.getState().startPairing({ ...link, fromOtherApp: true });
  }, [url]);

  const showPair = !hasActive || pairing;

  return (
    <View style={styles.fill}>
      <StatusBar style={cw.dark ? 'light' : 'dark'} />
      <PushedBack color={cw.case}>{showPair ? <PairScreen /> : <DeckScreen />}</PushedBack>
      <AuthHost />
      <ConnectNotice />
      <ToastHost />
    </View>
  );
}

/** Shrinks the app back like an iOS card stack while a phone sheet is open. */
function PushedBack({ color, children }: { color: string; children: ReactNode }) {
  const depth = useDepth();
  const stack = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(depth.value, [0, 1], [0, 10]) },
      { scale: interpolate(depth.value, [0, 1], [1, 0.93]) },
    ],
  }));
  // Scaling a whole deck every frame is costly, so while it moves it's drawn from a cached
  // texture. At rest it draws normally and stays sharp.
  const [moving, setMoving] = useState(false);
  useAnimatedReaction(
    () => depth.value > 0 && depth.value < 1,
    (now, before) => {
      if (now !== before) scheduleOnRN(setMoving, now);
    },
  );
  return (
    <Animated.View
      renderToHardwareTextureAndroid={moving}
      shouldRasterizeIOS={moving}
      style={[styles.fill, { backgroundColor: color, overflow: 'hidden' }, stack]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  crashBody: { maxWidth: 420, gap: 16 },
  crashOption: { gap: 10 },
  noticeLayer: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 12 },
  notice: { maxWidth: 520, width: '100%', gap: 12, paddingTop: 16, paddingBottom: 16 + 2 * VOXEL, paddingHorizontal: 20 },
  noticeButtons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12 },
});
