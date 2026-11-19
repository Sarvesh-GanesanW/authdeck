import { Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { type FontWeight, fonts, PIXEL_VARIANTS, typeScale, type TypeVariant } from '../theme/type';
import { useColorway, useScreen } from './theme';

type Tone = 'normal' | 'dim' | 'faint' | 'danger' | 'focus';

interface Props extends TextProps {
  variant?: TypeVariant;
  tone?: Tone;
  weight?: FontWeight;
  color?: string;
  center?: boolean;
}

const defaultWeight: Record<TypeVariant, FontWeight> = {
  display: 'semibold',
  title: 'semibold',
  heading: 'semibold',
  subhead: 'semibold',
  lead: 'regular',
  body: 'regular',
  label: 'regular',
  caption: 'regular',
  mono: 'regular',
};

export function Text({ variant = 'body', tone = 'normal', weight, color, center, style, ...rest }: Props) {
  const cw = useColorway();
  const { compact } = useScreen();
  const [size, line] = (compact ? typeScale.compact : typeScale.regular)[variant];
  const w = weight ?? defaultWeight[variant];
  const family = (PIXEL_VARIANTS.has(variant) ? fonts.pixel : fonts.plex)[w];
  const toneColor = {
    normal: cw.text,
    dim: cw.textDim,
    faint: cw.textFaint,
    danger: cw.dangerText,
    focus: cw.focus,
  }[tone];
  const base: TextStyle = {
    fontFamily: family,
    fontSize: size,
    lineHeight: line,
    color: color ?? toneColor,
    textAlign: center ? 'center' : undefined,
  };
  return <RNText {...rest} style={[base, style]} />;
}
