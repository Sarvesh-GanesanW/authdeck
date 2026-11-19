/** Browse folders (and optionally files) on the computer, and a path field that opens it. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, TextInput, View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { RequestError } from '../../net/client';
import { connection } from '../../net/connection';
import type { FsEntry, FsListResult } from '../../protocol';
import { fonts } from '../../theme/type';
import { Choice, GhostButton, IconButton, Press, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Well } from '../../ui/Panel';
import { SHORT_WINDOW, Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Shape, VOXEL } from '../../ui/voxel';
import { breadcrumbs } from './actionModel';
import { InputFrame, Notice, useEnv, useOnline } from './parts';

const ROW_H = 54;
/**
 * Below SHORT_WINDOW (a phone on its side) the places and the path share one row, the
 * computer's name is left out and rows are shorter, so the list keeps room for a few folders.
 */
const SHORT_ROW_H = 44;

interface Failure {
  message: string;
  hint?: string;
  notFound: boolean;
}

function toFailure(e: unknown): Failure {
  if (e instanceof RequestError) return { message: e.message, hint: e.hint, notFound: e.code === 'not_found' };
  return { message: e instanceof Error ? e.message : 'Could not read the folder.', notFound: false };
}

/** Loads folder listings, dropping answers that arrive after the user moved on. */
function useListing(visible: boolean, includeFiles: boolean, startPath?: string) {
  const [listing, setListing] = useState<FsListResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const go = useCallback(
    async (path?: string) => {
      const mine = ++seq.current;
      setLoading(true);
      setFailure(null);
      try {
        const res = await connection.listDir(path, includeFiles);
        if (mine === seq.current) setListing(res);
      } catch (e) {
        if (mine === seq.current) setFailure(toFailure(e));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [includeFiles],
  );

  useEffect(() => {
    if (!visible) return;
    setListing(null);
    void go(startPath?.trim() || undefined);
  }, [visible, startPath, go]);

  return { listing, failure, loading, go };
}

function FolderPickerSheet({
  visible,
  onClose,
  onPick,
  includeFiles = false,
  startPath,
  title,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  includeFiles?: boolean;
  startPath?: string;
  title?: string;
}) {
  const { agentId, computerName } = useEnv();
  const online = useOnline(agentId);
  const { listing, failure, loading, go } = useListing(visible && online, includeFiles, startPath);
  const short = useScreen().height < SHORT_WINDOW;
  const [file, setFile] = useState<FsEntry | null>(null);

  useEffect(() => setFile(null), [listing?.path]);

  const pick = (path: string) => {
    haptics.tick();
    onPick(path);
    onClose();
  };

  const footer = (
    <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <GhostButton label="Cancel" onPress={onClose} />
      {file ? (
        <PrimaryButton label={`Use ${file.name}`} onPress={() => pick(file.path)} />
      ) : (
        <PrimaryButton label="Use this folder" disabled={!listing || loading} onPress={() => listing && pick(listing.path)} />
      )}
    </View>
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title ?? (includeFiles ? 'Choose a file or folder' : 'Choose a folder')}
      subtitle={short ? undefined : `On ${computerName}`}
      tall
      noScroll
      maxWidth={760}
      footer={footer}
    >
      <View style={{ flex: 1, gap: short ? 8 : 14 }}>
        {!online ? (
          <Notice
            tone="warn"
            title={`Connect to ${computerName} to browse its folders`}
            detail="You can still type a path in the field instead. AuthDeck keeps trying to reconnect."
          />
        ) : (
          <>
            {listing ? <Places listing={listing} onGo={go} /> : null}
            {failure ? (
              <Notice
                tone="fail"
                title={failure.message}
                detail={failure.hint ?? (failure.notFound ? 'It may have been moved or deleted.' : undefined)}
              >
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                  <GhostButton small label="Try again" icon="refresh" onPress={() => go(listing?.path ?? (startPath || undefined))} />
                  <GhostButton small label="Go to home folder" icon="home" onPress={() => go(undefined)} />
                </View>
              </Notice>
            ) : null}
            {listing ? (
              <Entries listing={listing} loading={loading} selectedFile={file} onOpenDir={go} onSelectFile={setFile} />
            ) : loading ? (
              <Loading />
            ) : null}
          </>
        )}
      </View>
    </Sheet>
  );
}

function Loading() {
  const cw = useColorway();
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 16 }} accessibilityLiveRegion="polite">
      <ActivityIndicator color={cw.textDim} />
      <Text tone="dim">Reading the folder…</Text>
    </View>
  );
}

/** Shortcut places and the path as tappable breadcrumbs, with an up button. */
function Places({ listing, onGo }: { listing: FsListResult; onGo: (path: string) => void }) {
  const cw = useColorway();
  const oneRow = useScreen().height < SHORT_WINDOW;
  const crumbs = breadcrumbs(listing.path, listing.sep);
  const places = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={oneRow ? { flexGrow: 0, flexShrink: 1, maxWidth: '50%' } : undefined}>
      <Choice
        label="Places"
        wrap={false}
        value={listing.path}
        onChange={onGo}
        options={listing.roots.map((r) => ({ value: r.path, label: r.name, icon: r.path === listing.home ? 'home' : 'folder' }))}
      />
    </ScrollView>
  );
  return (
    <View style={oneRow ? { flexDirection: 'row', alignItems: 'center', gap: 12 } : { gap: 10 }}>
      {oneRow ? null : places}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: oneRow ? 1 : undefined }}>
        <IconButton
          icon="corner-left-up"
          label="Up one folder"
          disabled={!listing.parent}
          onPress={() => listing.parent && onGo(listing.parent)}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ alignItems: 'center', gap: 2 }}
          accessibilityLabel={`Current folder: ${listing.path}`}
        >
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={c.path} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                {i > 0 ? <Glyph name="chevron-right" size={12} color={cw.textFaint} /> : null}
                <Press
                  onPress={() => onGo(c.path)}
                  disabled={last}
                  accessibilityLabel={`Go to ${c.name}`}
                  style={{ paddingHorizontal: 6, paddingVertical: 8 }}
                >
                  <Text
                    variant="label"
                    weight={last ? 'semibold' : 'regular'}
                    tone={last ? 'normal' : 'dim'}
                  >
                    {c.name}
                  </Text>
                </Press>
              </View>
            );
          })}
        </ScrollView>
      </View>
      {oneRow ? places : null}
    </View>
  );
}

function Entries({
  listing,
  loading,
  selectedFile,
  onOpenDir,
  onSelectFile,
}: {
  listing: FsListResult;
  loading: boolean;
  selectedFile: FsEntry | null;
  onOpenDir: (path: string) => void;
  onSelectFile: (f: FsEntry | null) => void;
}) {
  const cw = useColorway();
  const rowH = useScreen().height < SHORT_WINDOW ? SHORT_ROW_H : ROW_H;
  if (listing.entries.length === 0) {
    return <Notice title="This folder is empty" detail="Use it as it is, or go up a level." />;
  }
  return (
    <Well style={{ flex: 1, opacity: loading ? 0.5 : 1, padding: VOXEL, paddingTop: 2 * VOXEL }}>
      <FlatList
        data={listing.entries}
        keyExtractor={(e) => e.path}
        accessibilityRole="list"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: rowH, offset: rowH * i, index: i })}
        renderItem={({ item }) => {
          const dir = item.kind === 'dir';
          const on = selectedFile?.path === item.path;
          return (
            <Press
              onPress={() => (dir ? onOpenDir(item.path) : onSelectFile(on ? null : item))}
              scaleTo={0.985}
              accessibilityRole={dir ? 'button' : 'radio'}
              accessibilityState={dir ? undefined : { selected: on }}
              accessibilityLabel={dir ? `Folder ${item.name}. Open` : `File ${item.name}`}
              style={{
                height: rowH,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 12,
              }}
            >
              {on ? <Shape steps={1} color={cw.surface} /> : null}
              <Glyph name={dir ? 'folder' : 'file'} size={24} color={dir ? cw.focus : cw.textDim} />
              <Text style={{ flex: 1 }} numberOfLines={1}>
                {item.name}
              </Text>
              {dir ? (
                <Glyph name="chevron-right" size={24} color={cw.textFaint} />
              ) : on ? (
                <Glyph name="check" size={24} color={cw.focus} />
              ) : null}
            </Press>
          );
        }}
      />
    </Well>
  );
}

/**
 * A path the user can type, with Browse to pick it on the computer.
 * Typing works offline; Browse needs the computer.
 */
export function PathField({
  label,
  value,
  placeholder,
  includeFiles,
  onChange,
  pickerTitle,
}: {
  label: string;
  value: string;
  placeholder: string;
  includeFiles?: boolean;
  onChange: (path: string) => void;
  pickerTitle?: string;
}) {
  const cw = useColorway();
  const { compact } = useScreen();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 7 }}>
      <Text variant="label" tone="dim">
        {label}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <InputFrame style={{ flex: 1, paddingLeft: 16 }}>
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder={placeholder}
            placeholderTextColor={cw.textFaint}
            selectionColor={cw.focus}
            accessibilityLabel={label}
            autoCorrect={false}
            autoCapitalize="none"
            style={{ position: 'relative', flex: 1, paddingVertical: 10, color: cw.text, fontFamily: fonts.plex.regular, fontSize: compact ? 15 : 16 }}
          />
          {value ? (
            <Press onPress={() => onChange('')} accessibilityLabel={`Clear ${label.toLowerCase()}`} hitSlop={6} style={{ padding: 12 }}>
              <Glyph name="close" size={24} color={cw.textDim} />
            </Press>
          ) : null}
        </InputFrame>
        <GhostButton small label="Browse" icon="folder" onPress={() => setOpen(true)} />
      </View>
      <FolderPickerSheet
        visible={open}
        onClose={() => setOpen(false)}
        onPick={onChange}
        includeFiles={includeFiles}
        startPath={value || undefined}
        title={pickerTitle}
      />
    </View>
  );
}
