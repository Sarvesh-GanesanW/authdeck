/** A computer's key words: a label, then two lines of three words, never cut off. */
import { View } from 'react-native';

import { keyWordLines } from '../net/linkState';
import { Text } from './Text';

export function KeyWords({ keyWords, label = 'Key words', large }: { keyWords: string; label?: string; large?: boolean }) {
  return (
    <View style={{ gap: large ? 4 : 2 }} accessible accessibilityLabel={`${label} ${keyWords}`}>
      <Text variant={large ? 'label' : 'caption'} tone="dim">
        {label}
      </Text>
      {keyWordLines(keyWords).map((line, row) => (
        <Text key={row} variant={large ? 'mono' : 'caption'} weight={large ? 'medium' : undefined} tone={large ? 'normal' : 'faint'} selectable={large}>
          {line}
        </Text>
      ))}
    </View>
  );
}
