/**
 * Fonts load from assets/fonts so every weight ships with the app (licences beside them).
 * The Pixelify Sans copies have their "fi"/"fl" ligatures removed (they read as other
 * letters, and iOS ignores fontVariant); regenerate them with scripts/strip-ligatures.py.
 */
export const fontAssets = {
  PixelifySans_400Regular: require('../../assets/fonts/PixelifySans_400Regular.ttf'),
  PixelifySans_500Medium: require('../../assets/fonts/PixelifySans_500Medium.ttf'),
  PixelifySans_600SemiBold: require('../../assets/fonts/PixelifySans_600SemiBold.ttf'),
  IBMPlexMono_400Regular: require('../../assets/fonts/IBMPlexMono_400Regular.ttf'),
  IBMPlexMono_500Medium: require('../../assets/fonts/IBMPlexMono_500Medium.ttf'),
  IBMPlexMono_600SemiBold: require('../../assets/fonts/IBMPlexMono_600SemiBold.ttf'),
};

export type FontWeight = 'regular' | 'medium' | 'semibold';

/**
 * Pixelify Sans only for titles, headings, page tabs and the brand: its pixel grid smears
 * at small sizes. IBM Plex Mono for everything else. Each weight is a real font file, so
 * nothing is synthetically bolded.
 */
export const fonts = {
  pixel: {
    regular: 'PixelifySans_400Regular',
    medium: 'PixelifySans_500Medium',
    semibold: 'PixelifySans_600SemiBold',
  },
  plex: {
    regular: 'IBMPlexMono_400Regular',
    medium: 'IBMPlexMono_500Medium',
    semibold: 'IBMPlexMono_600SemiBold',
  },
} as const satisfies Record<string, Record<FontWeight, string>>;

/** Variants set in Pixelify Sans; the rest use IBM Plex Mono. */
export const PIXEL_VARIANTS = new Set<TypeVariant>(['display', 'title', 'heading', 'subhead']);

/** Type scale (size / line height). Compact screens use the `compact` set. */
export const typeScale = {
  regular: {
    display: [44, 50],
    title: [28, 34],
    heading: [22, 28],
    /** Page tabs and banner titles. */
    subhead: [17, 22],
    /** Larger running text: pairing steps, list rows on tablets. */
    lead: [18, 26],
    body: [15, 21],
    label: [14, 20],
    caption: [13, 19],
    mono: [15, 21],
  },
  compact: {
    display: [32, 38],
    title: [24, 30],
    heading: [19, 24],
    subhead: [16, 21],
    lead: [16, 23],
    body: [15, 21],
    label: [13, 19],
    caption: [12, 17],
    mono: [13, 19],
  },
} as const;

export type TypeVariant = keyof typeof typeScale.regular;
