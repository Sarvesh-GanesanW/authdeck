/**
 * Adding, editing and deleting a variable, or adding several by pasting lines from a .env. A
 * SecureSheet: it shows and takes values. Saving signs a new line on this phone and the agent
 * writes it into the set's file.
 */
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import type { EnvApi, EnvSetDetail } from '../../auth/envContract';
import { envLoadsCode } from '../../envcore/codeLoading';
import { Choice, Field, GhostButton, PrimaryButton } from '../../ui/controls';
import { SecureSheet } from '../../ui/SecureSheet';
import { Text } from '../../ui/Text';
import { fonts } from '../../theme/type';
import { Notice } from '../authflows/parts';
import { showDone } from '../vault/feedback';
import { Hint } from '../vault/parts';
import { ButtonRow, FactTable } from './parts';
import { envSheets, useEnvSheets, type VariableSheetMode } from './sheetState';
import { useEnv } from './source';
import { listWords, LOADS_CODE_LINE, nextVersion, pasteSummary, readByWords, VARIABLE_NAME_RULE } from './view';

const CODE_FIELD = { fontFamily: fonts.plex.medium } as const;
/** Gboard suggests (and learns) words unless the field is a password-type field. */
const NO_SUGGESTIONS = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off', importantForAutofill: 'no' } as const;

export function VariableSheet() {
  const env = useEnv();
  const setId = useEnvSheets((s) => s.setId);
  const mode = useEnvSheets((s) => s.variable);
  const [shown, setShown] = useState(mode);
  if (mode && mode !== shown) setShown(mode);
  const detail = setId ? env.detail(setId) : null;
  const title = shown?.mode === 'edit' ? 'Edit variable' : 'Add variables';
  return (
    <SecureSheet visible={mode !== null && detail !== null} onClose={envSheets.closeVariable} title={title} subtitle={detail?.set.name} maxWidth={600}>
      {shown && detail ? <VariableBody key={shown.mode === 'edit' ? shown.name : 'add'} env={env} detail={detail} mode={shown} /> : null}
    </SecureSheet>
  );
}

function VariableBody({ env, detail, mode }: { env: EnvApi; detail: EnvSetDetail; mode: VariableSheetMode }) {
  const [kind, setKind] = useState<'one' | 'paste'>('one');
  if (mode.mode === 'edit') return <OneVariable env={env} detail={detail} editing={mode.name} />;
  return (
    <>
      <Choice
        label="How to add"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'one', label: 'One variable' },
          { value: 'paste', label: 'Paste lines from a .env' },
        ]}
      />
      {kind === 'one' ? <OneVariable env={env} detail={detail} editing={null} /> : <PasteLines env={env} detail={detail} />}
    </>
  );
}

function OneVariable({ env, detail, editing }: { env: EnvApi; detail: EnvSetDetail; editing: string | null }) {
  const { set, variables } = detail;
  const [name, setName] = useState(editing ?? '');
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(editing === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editing starts from the current value, read once.
  useEffect(() => {
    if (editing === null) return;
    let current = true;
    env
      .reveal(set.id, editing)
      .then((v) => {
        if (!current) return;
        setValue(v);
        setLoaded(true);
      })
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : `${editing} couldn't be read.`));
    return () => {
      current = false;
    };
  }, [env, set.id, editing]);

  const trimmed = name.trim();
  const problems = trimmed ? env.checkVariable(trimmed, value) : [];
  const replaces = editing === null && variables.some((v) => v.name === trimmed);
  const renamed = editing !== null && trimmed !== editing;
  const taken = renamed && variables.some((v) => v.name === trimmed);
  const ready = loaded && trimmed !== '' && problems.length === 0 && !taken && !busy;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await env.saveVariable(set.id, { name: trimmed, value, ...(editing !== null ? { previousName: editing } : {}) });
      showDone(`Saved ${trimmed}`);
      envSheets.closeVariable();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${trimmed} couldn't be saved. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () =>
    envSheets.confirm({
      title: `Delete ${editing}?`,
      message: `${editing} is removed from ${set.name} for every member. Processes already running keep it until they restart.`,
      confirmLabel: 'Delete',
      danger: true,
      action: async () => {
        await env.deleteVariable(set.id, editing!);
        envSheets.closeVariable();
        showDone(`Deleted ${editing}`);
      },
    });

  return (
    <>
      <View style={{ gap: 8 }}>
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="STRIPE_SECRET_KEY"
          {...NO_SUGGESTIONS}
          keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
          style={CODE_FIELD}
        />
        <Hint>{VARIABLE_NAME_RULE}</Hint>
      </View>
      <View style={{ gap: 8 }}>
        <Field
          label="Value"
          value={value}
          onChangeText={setValue}
          editable={loaded}
          placeholder={loaded ? 'The value' : 'Reading the value…'}
          multiline
          {...NO_SUGGESTIONS}
          style={[CODE_FIELD, { minHeight: 96, textAlignVertical: 'top' }]}
        />
        <Hint>Values may span several lines, such as PEM keys.</Hint>
      </View>
      {problems.map((problem) => (
        <Notice key={problem} tone="danger">
          {problem}
        </Notice>
      ))}
      {trimmed && envLoadsCode(trimmed) ? <Notice tone="warn">{`${trimmed}: ${LOADS_CODE_LINE}`}</Notice> : null}
      {replaces ? <Notice tone="warn">{`${trimmed} is already in ${set.name}. Saving replaces its value.`}</Notice> : null}
      {taken ? <Notice tone="danger">{`${trimmed} is already in ${set.name}. Pick another name, or edit that one.`}</Notice> : null}
      <FactTable
        facts={[
          { label: 'Read by', value: readByWords(detail) },
          { label: 'Saved as', value: `Version ${renamed ? 1 : nextVersion(variables, trimmed)}, signed by this phone` },
        ]}
      />
      <Text variant="caption" tone="dim">
        {`Processes already running keep the old value until they restart. Commit ${set.file} on ${set.computerName} to share the change.`}
      </Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ButtonRow>
        {editing !== null ? <GhostButton danger icon="trash" label="Delete" disabled={busy} onPress={askDelete} /> : null}
        <PrimaryButton icon="check" label={busy ? 'Saving' : 'Save'} busy={busy} disabled={!ready} onPress={() => void save()} />
      </ButtonRow>
    </>
  );
}

function PasteLines({ env, detail }: { env: EnvApi; detail: EnvSetDetail }) {
  const { set, variables } = detail;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = env.parseDotenv(text);
  const loadsCode = parsed.values.map((v) => v.name).filter(envLoadsCode);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await env.addVariables(set.id, parsed.values);
      showDone(parsed.values.length === 1 ? `Saved ${parsed.values[0]!.name}` : `Saved ${parsed.values.length} variables`);
      setText('');
      envSheets.closeVariable();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The variables couldn't be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label="Lines from a .env"
        value={text}
        onChangeText={setText}
        placeholder={'DATABASE_URL=postgres://…\nREDIS_URL=redis://…'}
        multiline
        {...NO_SUGGESTIONS}
        style={[CODE_FIELD, { minHeight: 140, textAlignVertical: 'top' }]}
      />
      <Text variant="label">{pasteSummary(parsed.values, variables)}</Text>
      {loadsCode.length > 0 ? <Notice tone="warn">{`${listWords(loadsCode)}: ${LOADS_CODE_LINE}`}</Notice> : null}
      {parsed.problems.map((problem) => (
        <Notice key={problem} tone="warn">
          {problem}
        </Notice>
      ))}
      <Hint>{`Each one is signed by this phone as its own line. Commit ${set.file} on ${set.computerName} to share them.`}</Hint>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <PrimaryButton
        icon="check"
        label={parsed.values.length > 1 ? `Save ${parsed.values.length} variables` : 'Save'}
        busy={busy}
        disabled={parsed.values.length === 0}
        onPress={() => void add()}
      />
    </>
  );
}
