/** History: whether every device's signed log checks out, alerts, and the list of changes. */
import { View } from 'react-native';

import type { HistoryItem, VaultSnapshot } from '../../auth/contract';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { clockTime, historyTime } from './format';
import { Alert, EmptyNote, Hint, StatusLight } from './parts';

type HistoryProps = Pick<VaultSnapshot, 'history' | 'rollbackWarning'>;

/** Everything under the History heading; the caller supplies the heading and the scrolling. */
export function HistoryBody({ history, rollbackWarning }: HistoryProps) {
  const rejected = history.filter((item) => item.status === 'rejected');
  return (
    <>
      <Hint>
        Every change is signed by the device that made it and linked to the one before, so nothing can be added, edited or removed unnoticed. Times are each
        device's own clock.
      </Hint>
      {rollbackWarning ? <Alert title="The history went backwards">{rollbackWarning}</Alert> : null}
      {rejected.map((item) => (
        <Alert key={item.id} title="A change was rejected">
          {`At ${clockTime(item.time)} by its clock, "${item.text}" from ${bylineText(item)}. ${item.reason ?? 'It was ignored and nothing changed.'}`}
        </Alert>
      ))}
      {history.length === 0 ? (
        <EmptyNote icon="clock" title="No changes yet">
          <Text variant="caption" tone="dim" center>
            Adding an account or trusting a device shows up here.
          </Text>
        </EmptyNote>
      ) : (
        <View accessibilityRole="list">
          {history.map((item, i) => (
            <HistoryRow key={item.id} item={item} first={i === 0} />
          ))}
        </View>
      )}
    </>
  );
}

export function ChainStatus({ chainOk }: { chainOk: boolean }) {
  const cw = useColorway();
  return chainOk ? <StatusLight label="Chain verified" color={cw.ok} /> : <StatusLight label="Chain not verified" color={cw.run} />;
}

/**
 * "Pixel 8 (amber orbit tulip)": the key words come from the signing key, so a device that takes
 * another's name still shows its own words. A name used by several devices is flagged.
 */
function bylineText(item: HistoryItem): string {
  const words = item.byKeyWords ? ` (${item.byKeyWords})` : '';
  const shared = item.byNameShared ? `; ${item.byNameShared} devices use this name` : '';
  return `${item.by}${words}${shared}`;
}

function HistoryRow({ item, first }: { item: HistoryItem; first: boolean }) {
  const cw = useColorway();
  const light = item.status === 'applied' ? cw.ok : item.status === 'rejected' ? cw.danger : cw.run;
  const who = bylineText(item);
  const by = item.status === 'rejected' ? `from ${who}, rejected` : item.status === 'waiting' ? `by ${who}, waiting` : `by ${who}`;
  return (
    <View
      accessibilityRole="text"
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 4,
        borderTopWidth: first ? 0 : VOXEL / 2,
        borderTopColor: cw.line,
      }}
    >
      <View style={{ width: 10, height: 10, marginTop: 5, marginRight: 4, backgroundColor: light }} />
      <Text variant="caption" tone="dim" style={{ width: 76, marginTop: 1 }}>
        {historyTime(item.time)}
      </Text>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text weight="semibold">{item.text}</Text>
        <Text variant="caption" tone="dim">
          {item.status === 'waiting' && item.reason ? `${by}. ${item.reason}` : by}
        </Text>
      </View>
    </View>
  );
}
