/** Turning an app icon the computer sent into something drawable, without throwing on bad data. */
import { isAppIcon } from './messages';

/** What to draw for a stored icon: a checked PNG's base64, or null for the placeholder. */
export type DrawableIcon = { kind: 'png'; base64: string } | null;

/** Checks the icon again (whatever path it took into the store); never throws. */
export function drawableIcon(icon: unknown): DrawableIcon {
  return isAppIcon(icon) ? { kind: 'png', base64: icon.data } : null;
}
