/** The Accounts section: search, one row per account, and the detail sheet for the tapped one. */
import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import type { AccountView } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { GhostButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { SunkenFace, VOXEL } from '../../ui/voxel';
import { fonts } from '../../theme/type';
import { AccountSheet } from './AccountSheet';
import { accountDetail, accountGlyph, accountName, accountTag, matchesSearch } from './format';
import { EmptyNote, Hint, ItemRow, SECTION_GAP, SectionWell, Tag } from './parts';
import { vaultFeatures } from '../../vault/features';

export function AccountsSection({ accounts, fill }: { accounts: AccountView[]; fill: boolean }) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const open = accounts.find((a) => a.id === openId) ?? null;
  const shown = accounts.filter((a) => matchesSearch(a, query));

  const rows = shown.map((account) => (
    <ItemRow
      key={account.id}
      icon={accountGlyph(account)}
      title={accountName(account)}
      detail={accountDetail(account)}
      detailLines={1}
      trailing={<Tag label={accountTag(account)} />}
      onPress={() => setOpenId(account.id)}
      accessibilityLabel={`${accountName(account)}, ${account.label}`}
    />
  ));

  const list =
    accounts.length === 0 ? (
      <NoAccounts />
    ) : shown.length === 0 ? (
      <EmptyNote icon="search" title={`Nothing matches "${query.trim()}"`}>
        <Text variant="caption" tone="dim" center>
          {vaultFeatures.multiDevice ? 'Search looks in the site name, the account and the team.' : 'Search looks in the site name and the account.'}
        </Text>
      </EmptyNote>
    ) : (
      rows
    );

  return (
    <SectionWell title="Accounts" style={fill ? { flex: 1, minHeight: 0 } : null}>
      {accounts.length > 0 ? <SearchField value={query} onChange={setQuery} /> : null}
      {fill ? (
        <ScrollView
          style={{ flex: 1, marginHorizontal: -6 }}
          contentContainerStyle={{ gap: SECTION_GAP, paddingHorizontal: 6, paddingBottom: VOXEL }}
          showsVerticalScrollIndicator={false}
        >
          {list}
        </ScrollView>
      ) : (
        list
      )}
      <Hint style={{ marginTop: 4 }}>Codes are made on this device. The computer only ever receives the digits you type with a key.</Hint>
      <AccountSheet account={open} onClose={() => setOpenId(null)} />
    </SectionWell>
  );
}

function NoAccounts() {
  const open = useAuthUi((s) => s.open);
  return (
    <EmptyNote icon="key" title="No accounts yet">
      <Text variant="caption" tone="dim" center>
        Scan the QR code a site shows when you turn on two-factor, or move your accounts over from Google Authenticator.
      </Text>
      <View style={{ marginTop: 6 }}>
        <GhostButton small icon="plus" label="Add an account" onPress={() => open('add-account')} />
      </View>
    </EmptyNote>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <View
      accessibilityRole="search"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: compact ? 44 : 48, paddingLeft: 14, paddingRight: 6, paddingTop: VOXEL }}
    >
      <SunkenFace color={cw.surfaceAlt} lip={cw.lip} />
      <Glyph name="search" size={24} color={cw.textFaint} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search accounts"
        placeholderTextColor={cw.textFaint}
        selectionColor={cw.focus}
        accessibilityLabel="Search accounts"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        style={{
          position: 'relative',
          flex: 1,
          height: '100%',
          color: cw.text,
          fontFamily: fonts.plex.regular,
          fontSize: compact ? 14 : 15,
          paddingVertical: 0,
        }}
      />
    </View>
  );
}
