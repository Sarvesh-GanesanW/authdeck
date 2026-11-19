/** Typing the key a site shows under its QR code, with the rarer settings under Advanced. */
import { type ReactNode, useState } from 'react';
import { Platform, View } from 'react-native';

import type { NewAccount, OtpAlgorithm, OtpType } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { Choice, Field, GhostButton, PrimaryButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { announceAdded, DEFAULT_ACCOUNT, shapeForType } from './addFlow';
import { codeShape } from './format';
import { Problems } from './Problems';
import type { AddStep } from './ScanStep';

const TYPE_OPTIONS: { value: OtpType; label: string }[] = [
  { value: 'totp', label: 'TOTP' },
  { value: 'hotp', label: 'HOTP' },
  { value: 'steam', label: 'Steam' },
];
const ALGORITHM_OPTIONS: { value: OtpAlgorithm; label: string }[] = [
  { value: 'SHA1', label: 'SHA-1' },
  { value: 'SHA256', label: 'SHA-256' },
  { value: 'SHA512', label: 'SHA-512' },
];
const DIGIT_OPTIONS = [6, 7, 8].map((n) => ({ value: String(n), label: `${n} digits` }));

/** The form keeps numbers as typed text and reads them only when adding. */
interface Draft {
  issuer: string;
  label: string;
  secret: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  digits: number;
  period: string;
  counter: string;
}

const EMPTY_DRAFT: Draft = {
  issuer: '',
  label: '',
  secret: '',
  type: DEFAULT_ACCOUNT.type,
  algorithm: DEFAULT_ACCOUNT.algorithm,
  digits: DEFAULT_ACCOUNT.digits,
  period: String(DEFAULT_ACCOUNT.period),
  counter: '0',
};

const WHOLE_NUMBER = /^\d+$/;

/** Reads the draft into an account, or says which number is not one. */
function readDraft(draft: Draft): { account: NewAccount } | { problem: string } {
  if (draft.type === 'totp' && (!WHOLE_NUMBER.test(draft.period.trim()) || Number(draft.period) === 0)) {
    return { problem: 'The period should be a whole number of seconds, like 30.' };
  }
  if (draft.type === 'hotp' && !WHOLE_NUMBER.test(draft.counter.trim())) {
    return { problem: 'The counter should be a whole number, like 0.' };
  }
  return {
    account: {
      issuer: draft.issuer.trim(),
      label: draft.label.trim(),
      secret: draft.secret,
      type: draft.type,
      ...shapeFromDraft(draft),
      ...(draft.type === 'hotp' ? { counter: Number(draft.counter) } : null),
    },
  };
}

function shapeFromDraft(draft: Draft): Pick<NewAccount, 'digits' | 'period' | 'algorithm'> {
  if (draft.type === 'steam') return shapeForType('steam');
  if (draft.type === 'hotp') return { digits: draft.digits, period: 0, algorithm: draft.algorithm };
  return { digits: draft.digits, period: Number(draft.period), algorithm: draft.algorithm };
}

export function useManualStep({ onDone }: { onDone: () => void }): AddStep {
  const vault = useVault();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [advanced, setAdvanced] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const change = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const add = async () => {
    const read = readDraft(draft);
    const invalid = 'problem' in read ? [read.problem] : vault.checkAccount(read.account);
    setProblems(invalid);
    if ('problem' in read || invalid.length > 0) {
      haptics.warning();
      return;
    }
    setBusy(true);
    try {
      await vault.addAccounts([read.account]);
      announceAdded([read.account]);
      onDone();
    } catch (e) {
      haptics.error();
      setProblems([e instanceof Error ? e.message : 'The account was not added. Try again.']);
    } finally {
      setBusy(false);
    }
  };

  const steam = draft.type === 'steam';
  const preview = readDraft(draft);
  const body = (
    <>
      <Text variant="caption" tone="dim">
        Sites show the key as a row of letters and digits, often under the QR code with a link like "Can't scan it?". The key stays on this device; the computer
        never sees it.
      </Text>
      <Field label="Name on the key" value={draft.issuer} onChangeText={(issuer) => change({ issuer })} placeholder="GitHub" />
      <Field label="Account" value={draft.label} onChangeText={(label) => change({ label })} placeholder="you@example.com" autoCapitalize="none" />
      <Field
        label="Key"
        value={draft.secret}
        onChangeText={(secret) => change({ secret })}
        placeholder="JBSW Y3DP EHPK 3PXP"
        autoCapitalize="characters"
        // The key is a secret: no suggestions, learning or autofill. Gboard ignores autoCorrect
        // alone; a password-type field turns its suggestions off.
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        importantForAutofill="no"
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
      />
      <View style={{ alignItems: 'flex-start' }}>
        <GhostButton
          small
          icon={advanced ? 'chevron-down' : 'chevron-right'}
          label={advanced ? 'Hide advanced' : 'Advanced'}
          onPress={() => setAdvanced((a) => !a)}
        />
      </View>
      {advanced ? (
        <View style={{ gap: 18 }}>
          <Text variant="caption" tone="dim">
            Only change these when the site tells you to. Most sites use TOTP, SHA-1, 6 digits and 30 seconds.
          </Text>
          <Labelled label="Type">
            <Choice label="Type" options={TYPE_OPTIONS} value={draft.type} onChange={(type) => change({ type, ...draftShape(type) })} />
          </Labelled>
          {steam ? (
            <Text variant="caption" tone="dim">
              Steam Guard codes are always five characters, new every 30 seconds.
            </Text>
          ) : (
            <>
              <Labelled label="Algorithm">
                <Choice label="Algorithm" options={ALGORITHM_OPTIONS} value={draft.algorithm} onChange={(algorithm) => change({ algorithm })} />
              </Labelled>
              <Labelled label="Digits">
                <Choice label="Digits" options={DIGIT_OPTIONS} value={String(draft.digits)} onChange={(digits) => change({ digits: Number(digits) })} />
              </Labelled>
              {draft.type === 'totp' ? (
                <Field label="Seconds per code" value={draft.period} onChangeText={(period) => change({ period })} keyboardType="number-pad" />
              ) : (
                <Field label="Counter" value={draft.counter} onChangeText={(counter) => change({ counter })} keyboardType="number-pad" />
              )}
            </>
          )}
        </View>
      ) : null}
      {'account' in preview ? (
        <Text variant="caption" tone="dim">
          {codeShape(preview.account)}
        </Text>
      ) : null}
      <Problems problems={problems} />
    </>
  );

  const action = <PrimaryButton label="Add account" busy={busy} disabled={!draft.secret.trim()} onPress={() => void add()} />;
  return { body, action };
}

/** Form values for a newly picked type. */
function draftShape(type: OtpType): Partial<Draft> {
  const shape = shapeForType(type);
  return { digits: shape.digits, algorithm: shape.algorithm, period: String(shape.period || DEFAULT_ACCOUNT.period) };
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" tone="dim">
        {label}
      </Text>
      {children}
    </View>
  );
}
