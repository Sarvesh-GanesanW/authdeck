/**
 * The connected computer's name with a status light. Opens the computer switcher. Where the
 * header has no room for the name, the light alone, in a square block (`dotOnly`).
 */
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { useLive } from '../../state/live';
import { Glyph } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { HeaderButton } from './HeaderButton';

const STATUS_WORDS = {
  idle: 'not connected',
  connecting: 'connecting',
  online: 'connected',
  offline: 'offline, reconnecting',
  unauthorized: 'needs pairing again',
} as const;

export function StatusPill({ name, compact, dotOnly, onPress }: { name: string; compact: boolean; dotOnly?: boolean; onPress: () => void }) {
  const cw = useColorway();
  const status = useLive((s) => s.status);
  const pulse = useSharedValue(1);

  const color = status === 'online' ? cw.ok : status === 'unauthorized' || status === 'offline' ? cw.danger : cw.run;
  const pulsing = status === 'connecting' || status === 'offline';

  useEffect(() => {
    pulse.value = pulsing
      ? withRepeat(withSequence(withTiming(0.3, { duration: 650 }), withTiming(1, { duration: 650 })), -1)
      : withTiming(1, { duration: 200 });
  }, [pulsing, pulse]);
  const light = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const size = compact ? 6 : 8;
  const lamp = (
    // A square lamp with a square halo.
    <Animated.View style={[{ width: size, height: size, backgroundColor: color }, light]}>
      <View style={{ position: 'absolute', left: -3, top: -3, right: -3, bottom: -3, backgroundColor: color, opacity: 0.22 }} />
    </Animated.View>
  );
  const spoken = `${name}, ${STATUS_WORDS[status]}. Switch computer`;
  if (dotOnly) {
    return (
      <HeaderButton label={name} compact={compact} iconOnly onPress={onPress} accessibilityLabel={spoken}>
        {lamp}
      </HeaderButton>
    );
  }
  return (
    <HeaderButton
      label={name}
      compact={compact}
      shrink
      onPress={onPress}
      accessibilityLabel={spoken}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 8 : 10, marginRight: -6, minWidth: 0, flexShrink: 1 }}>
        {lamp}
        <Text weight="medium" numberOfLines={1} style={{ flexShrink: 1 }}>
          {name}
        </Text>
        <Glyph name="chevron-down" size={24} color={cw.textDim} />
      </View>
    </HeaderButton>
  );
}
