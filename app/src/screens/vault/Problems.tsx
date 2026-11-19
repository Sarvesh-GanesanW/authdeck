/** Plain sentences about what is wrong, under a form or a scan. */
import { View } from 'react-native';

import { Text } from '../../ui/Text';

export function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
      {problems.map((problem) => (
        <Text key={problem} tone="danger" variant="label">
          {problem}
        </Text>
      ))}
    </View>
  );
}
