/** Page settings: name, project folder, linked app, 2FA page, number of keys, order, and delete. */
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { MAX_SLOTS, MIN_SLOTS, type Page } from '../../state/model';
import { entryFor, useStore } from '../../state/store';
import { withAccountKeys } from '../../state/templates';
import { Field, GhostButton, IconButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { AppChoice } from './AppPicker';
import { PathField } from './FolderPicker';
import { Divider, EnvProvider, Notice, Section, SettingRow, useEditorEnv } from './parts';
import { ConfirmDelete } from './TryIt';

export function PageSettingsSheet({
  visible,
  agentId,
  pageId,
  onClose,
}: {
  visible: boolean;
  agentId: string;
  pageId: string;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Page settings" maxWidth={640}>
      <PageSettings agentId={agentId} pageId={pageId} onClose={onClose} />
    </Sheet>
  );
}

function PageSettings({ agentId, pageId, onClose }: { agentId: string; pageId: string; onClose: () => void }) {
  const pages = useStore((s) => entryFor(s.decks, agentId)?.pages);
  const livePage = pages?.find((p) => p.id === pageId) ?? null;
  // Keep showing the page while the sheet animates away after a delete.
  const lastPage = useRef(livePage);
  if (livePage) lastPage.current = livePage;
  const page = livePage ?? lastPage.current;
  const env = useEditorEnv(agentId, page?.cwd);
  const autoSwitch = useStore((s) => s.settings.autoSwitch);
  const { updatePage, resizePage, movePage, removePage } = useStore.getState();

  if (!env)
    return <Notice tone="warn" title="This computer is no longer paired" detail="Pair it again from Settings to change its pages." />;
  if (!page || !pages) return <Notice title="This page is gone" detail="It may have been deleted. Close this sheet." />;

  const position = pages.findIndex((p) => p.id === pageId);
  const isOnlyPage = pages.length <= 1;
  const keyCount = page.slots.filter(Boolean).length;
  const set = (fn: (p: Page) => Page) => updatePage(agentId, pageId, fn);
  const move = (by: -1 | 1) => {
    haptics.tick();
    movePage(agentId, position, position + by);
  };

  return (
    <EnvProvider value={env}>
      <Field
        label="Name"
        value={page.name}
        placeholder="Name this page"
        maxLength={24}
        onChangeText={(name) => set((p) => ({ ...p, name }))}
        onBlur={() => {
          if (!page.name.trim()) set((p) => ({ ...p, name: `Page ${position + 1}` }));
        }}
      />

      <View style={{ gap: 6 }}>
        <PathField
          label="Project folder"
          value={page.cwd ?? ''}
          placeholder="Home folder"
          pickerTitle="Project folder"
          onChange={(cwd) => set((p) => ({ ...p, cwd: cwd.trim() ? cwd : undefined }))}
        />
        <Text variant="label" tone="faint">
          Commands on this page run here, unless a key sets its own folder.
        </Text>
      </View>

      <Section label="Bring this page forward when this app is in front" gap={8}>
        <AppChoice
          appId={page.focusApp?.appId}
          appName={page.focusApp?.appName}
          emptyText="No app linked"
          pickerTitle="Link this page to"
          onPick={(app) => set((p) => ({ ...p, focusApp: { appId: app.id, appName: app.name } }))}
          onClear={() => set((p) => ({ ...p, focusApp: null }))}
        />
        {page.focusApp && !autoSwitch ? (
          <Text variant="label" tone="faint">
            Switching pages by app is turned off in Settings, so this link has no effect until you turn it on.
          </Text>
        ) : null}
      </Section>

      <Divider />

      <TwoFactorSection page={page} onChange={set} />

      <Divider />

      <KeyCountStepper count={page.slots.length} keyCount={keyCount} onChange={(size) => resizePage(agentId, pageId, size)} />

      <Divider />

      <Section label={`Position: page ${position + 1} of ${pages.length}`} gap={10}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <GhostButton small label="Move left" icon="arrow-left" disabled={position <= 0} onPress={() => move(-1)} />
          <GhostButton small label="Move right" icon="arrow-right" disabled={position >= pages.length - 1} onPress={() => move(1)} />
        </View>
      </Section>

      <View style={{ gap: 8 }}>
        <ConfirmDelete
          label="Delete page"
          question={`Delete “${page.name || 'this page'}”?`}
          detail={
            keyCount > 0
              ? `Its ${keyCount === 1 ? 'key is' : `${keyCount} keys are`} deleted too. This cannot be undone.`
              : 'This cannot be undone.'
          }
          confirmLabel="Delete page"
          disabled={isOnlyPage}
          onConfirm={() => {
            removePage(agentId, pageId);
            onClose();
          }}
        />
        {isOnlyPage ? (
          <Text variant="label" tone="faint">
            This is the only page, so it cannot be deleted. Add another page first.
          </Text>
        ) : null}
      </View>
    </EnvProvider>
  );
}

/** Number of spots on the page. Shrinking only removes empty spots, never keys. */
function KeyCountStepper({ count, keyCount, onChange }: { count: number; keyCount: number; onChange: (n: number) => void }) {
  const canShrink = count > MIN_SLOTS && count > keyCount;
  const canGrow = count < MAX_SLOTS;
  const step = (by: -1 | 1) => {
    haptics.tick();
    onChange(count + by);
  };
  return (
    <View style={{ gap: 10 }}>
      <SettingRow title="Spots for keys" detail={`${keyCount} in use. The deck fits them to the screen.`}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Spots for keys"
          accessibilityValue={{ min: MIN_SLOTS, max: MAX_SLOTS, now: count }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment' && canGrow) step(1);
            if (e.nativeEvent.actionName === 'decrement' && canShrink) step(-1);
          }}
        >
          <IconButton icon="minus" label="Fewer spots" disabled={!canShrink} onPress={() => step(-1)} />
          <Text variant="lead" weight="semibold" center style={{ minWidth: 44 }}>
            {count}
          </Text>
          <IconButton icon="plus" label="More spots" disabled={!canGrow} onPress={() => step(1)} />
        </View>
      </SettingRow>
      <Text variant="label" tone="faint">
        {count > keyCount
          ? `From ${MIN_SLOTS} to ${MAX_SLOTS}. Fewer spots only removes empty ones; keys are never deleted.`
          : 'Every spot holds a key. Move or delete a key to make the page smaller; shrinking never deletes keys.'}
      </Text>
    </View>
  );
}

const DEFAULT_PAGE_NAME = /^Page \d+$/;

/**
 * Turns the page into a 2FA page filled with a key for every vault account (or back), and
 * fills in accounts added since. Without a vault it offers to set one up.
 */
function TwoFactorSection({ page, onChange }: { page: Page; onChange: (fn: (p: Page) => Page) => void }) {
  const vault = useVault();
  const [fillWhenOpen, setFillWhenOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const missing = vault.accounts.filter((a) => !page.slots.some((k) => k?.otp?.accountId === a.id)).length;

  const fill = () => {
    let added = 0;
    let left = 0;
    onChange((p) => {
      // A page still on its default name is named for what it now holds.
      const name = DEFAULT_PAGE_NAME.test(p.name) ? '2FA' : p.name;
      const placed = withAccountKeys({ ...p, name, otp: true }, vault.accounts);
      added = placed.added;
      left = placed.left;
      return placed.page;
    });
    haptics.tick();
    setNote(
      left > 0
        ? `${left === 1 ? 'One account' : `${left} accounts`} did not fit: a page holds up to ${MAX_SLOTS} keys.`
        : added > 0
          ? `Added ${added === 1 ? 'a key' : `${added} keys`}.`
          : null,
    );
  };

  // A locked vault lists no accounts: unlock, then fill once the accounts are readable.
  useEffect(() => {
    if (!fillWhenOpen || vault.status !== 'open') return;
    setFillWhenOpen(false);
    fill();
    // `fill` reads the accounts this render has; it runs once, right after unlocking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillWhenOpen, vault.status]);

  const unlockThenFill = async () => {
    setUnlockError(null);
    try {
      await vault.unlock();
      setFillWhenOpen(true);
    } catch (e) {
      setUnlockError(e instanceof Error ? e.message : 'The vault stayed locked.');
    }
  };

  if (vault.status === 'loading') return null;
  if (vault.status === 'none') {
    return (
      <SettingRow title="2FA page" detail="Set up the authenticator to put live 2FA codes on a page.">
        <GhostButton small label="Set up the authenticator" onPress={() => useAuthUi.getState().open('intro')} />
      </SettingRow>
    );
  }
  const locked = vault.status === 'locked';
  const run = () => (locked ? void unlockThenFill() : fill());
  return (
    <View style={{ gap: 10 }}>
      {page.otp ? (
        <SettingRow
          title="2FA page"
          detail={missing > 0 ? `${missing === 1 ? 'One account has' : `${missing} accounts have`} no key here yet.` : 'Empty spots add an account.'}
        >
          {missing > 0 || locked ? <GhostButton small label={locked ? 'Unlock and add' : 'Add them'} onPress={run} /> : null}
        </SettingRow>
      ) : (
        <SettingRow title="2FA page" detail="A key for every account in the vault, showing its live code.">
          <GhostButton small label="Make 2FA page" icon="lock" onPress={run} />
        </SettingRow>
      )}
      {unlockError ? <Notice tone="fail" title={unlockError} detail="Try again." /> : null}
      {note ? (
        <Text variant="label" tone="faint">
          {note}
        </Text>
      ) : null}
      {page.otp ? (
        <View style={{ flexDirection: 'row' }}>
          <GhostButton
            small
            label="Make it a normal page"
            onPress={() => {
              setNote(null);
              onChange(({ otp: _otp, ...p }) => p);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
