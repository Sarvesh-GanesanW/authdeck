/**
 * Icons. Symbols come from the pixel icon set (see pixelIcons.ts), drawn on a 24-unit
 * grid with 2-unit pixels, so sizes that are multiples of 12 land every pixel on the
 * screen grid: 24 for controls, 36 or 48 on keys.
 */
import { Component, memo, type ReactNode, useEffect, useMemo } from 'react';
import { Image, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { connection } from '../net/connection';
import { drawableIcon } from '../net/iconData';
import { iconCanary, useIconCanary } from '../state/iconCanary';
import { useLive } from '../state/live';
import { useStore } from '../state/store';
import type { KeyIcon } from '../state/model';
import { type GlyphName, PIXEL_ICONS } from './pixelIcons';
import { Shape } from './voxel';

export type { GlyphName };

function isGlyphName(name: string): name is GlyphName {
  return Object.prototype.hasOwnProperty.call(PIXEL_ICONS, name);
}

/**
 * Names saved by earlier builds, which used another icon set. Decks keep working:
 * each old name maps to the closest pixel icon.
 */
const LEGACY: Record<string, GlyphName> = {
  AppWindow: 'app-windows',
  Archive: 'archive',
  ArchiveArrowUp: 'arrow-up-box',
  ArrowDownToDot: 'arrow-bar-down',
  ArrowDownToLine: 'download',
  ArrowRightToLine: 'arrow-bar-right',
  ArrowUpFromDot: 'arrow-bar-up',
  ArrowUpFromLine: 'upload',
  Ban: 'cancel',
  Bot: 'robot',
  Box: 'box',
  Braces: 'braces',
  Camera: 'camera',
  CameraOff: 'camera',
  CircleCheck: 'checkbox-on',
  CircleDot: 'target',
  CircleExclamationPoint: 'square-alert',
  CircleStop: 'stop',
  CircleX: 'cancel',
  ClipboardPaste: 'clipboard',
  ClockArrowLeft: 'clock',
  Columns2: 'text-colums',
  Container: 'docker',
  CornerLeftUp: 'corner-left-up',
  FileCode: 'file-text',
  FileDiff: 'file-text',
  FileSearch: 'files',
  FlaskConical: 'test-tube',
  FolderOpen: 'folder',
  GitCommitHorizontal: 'git-commit',
  Hammer: 'tools',
  House: 'home',
  Info: 'circle-info',
  KeyRound: 'key',
  ListChecks: 'list-box',
  ListOrdered: 'bulletlist',
  MessageSquare: 'message',
  MessageSquareCode: 'message-text',
  PackagePlus: 'package',
  PanelLeft: 'layout',
  PencilLine: 'pencil',
  Redo2: 'redo',
  RefreshCw: 'refresh',
  Rocket: 'zap',
  RotateCcw: 'reload',
  RotateCw: 'reload',
  SaveAll: 'save',
  ScanQrCode: 'qr-code',
  ScanSearch: 'check-double',
  Settings: 'settings-cog',
  Square: 'stop',
  SquareChevronRight: 'square-chevron-right',
  SquareTerminal: 'terminal',
  TextAlignStart: 'text-align-left',
  Timer: 'hourglass',
  Trash2: 'trash',
  Type: 'text-cursor',
  Undo2: 'undo',
  X: 'close',
};

/** Turns any saved icon name into a pixel icon, falling back to a plain box. */
export function resolveGlyph(name: string): GlyphName {
  if (isGlyphName(name)) return name;
  const legacy = LEGACY[name];
  if (legacy) return legacy;
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return isGlyphName(kebab) ? kebab : 'box';
}

export const Glyph = memo(function Glyph({
  name,
  size = 24,
  color,
  shadow,
}: {
  name: GlyphName;
  size?: number;
  color: string;
  /** Hard shadow one icon pixel below, for icons printed on a block. */
  shadow?: string;
}) {
  const d = PIXEL_ICONS[name];
  const paths = typeof d === 'string' ? [d] : d;
  const draw = (fill: string) => paths.map((p, i) => <Path key={i} d={p} fill={fill} />);
  if (!shadow) {
    return (
      // Positioned so it paints above voxel faces drawn before it (browsers paint
      // absolutely positioned layers over unpositioned content).
      <Svg width={size} height={size} viewBox="0 0 24 24" pointerEvents="none" style={{ position: 'relative' }}>
        {draw(color)}
      </Svg>
    );
  }
  const px = size / 12;
  return (
    <View style={{ width: size, height: size + px }} pointerEvents="none">
      <Svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', top: px }}>
        {draw(shadow)}
      </Svg>
      <Svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', top: 0 }}>
        {draw(color)}
      </Svg>
    </View>
  );
});

interface AppIconProps {
  appId: string;
  size: number;
  placeholderColor: string;
}

function IconPlaceholder({ size, placeholderColor }: Omit<AppIconProps, 'appId'>) {
  const glyph = size >= 40 ? 24 : 12;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Shape steps={1} v={size >= 40 ? 4 : 2} color={placeholderColor} />
      <Glyph name="box" size={glyph} color="rgba(255,255,255,0.55)" />
    </View>
  );
}

/**
 * Whether a computer's icon may draw now, under the crash canary (state/iconCanary.ts): not before
 * the previous launch's mark is read, never for a computer whose icons were drawing when AuthDeck
 * last closed, and the first time in a launch only once the mark naming the computer is saved.
 */
function useCanaryPermit(icon: object | null): { mayDraw: boolean; onDrawn: () => void } {
  const agentId = useStore((s) => s.activeId);
  const checked = useIconCanary((s) => s.checked);
  const hidden = useIconCanary((s) => agentId !== null && s.hidden.includes(agentId));
  const armed = useIconCanary((s) => agentId !== null && s.armed.includes(agentId));
  const allowed = icon !== null && agentId !== null && checked && !hidden;
  const drewBefore = icon !== null && iconCanary.hasDrawn(icon);
  const needsMark = allowed && !drewBefore;
  useEffect(() => {
    if (!needsMark || !icon || !agentId) return;
    iconCanary.begin(agentId, icon);
    return () => iconCanary.abandon(icon);
  }, [needsMark, agentId, icon]);
  return {
    mayDraw: allowed && (drewBefore || armed),
    onDrawn: () => {
      if (icon) iconCanary.finish(icon);
    },
  };
}

/** Draws the computer's icon; anything that isn't a well-formed PNG icon draws the placeholder. */
function ComputerIcon({ appId, size, placeholderColor }: AppIconProps) {
  const icon = useLive((s) => s.icons[appId]);
  const online = useLive((s) => s.status === 'online');
  // Kept in memory while shown; past the memory budget, icons not shown may be dropped.
  useEffect(() => connection.holdIcon(appId), [appId]);
  useEffect(() => {
    if (icon === undefined && online) void connection.loadIcons([appId]);
  }, [appId, icon, online]);
  const drawable = useMemo(() => drawableIcon(icon), [icon]);
  const { mayDraw, onDrawn } = useCanaryPermit(drawable ? (icon as object) : null);

  if (!drawable || !mayDraw) return <IconPlaceholder size={size} placeholderColor={placeholderColor} />;
  return (
    <Image
      source={{ uri: `data:image/png;base64,${drawable.base64}` }}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      onLoad={onDrawn}
      onError={onDrawn}
    />
  );
}

/**
 * Catches an icon that fails while drawing in JS, so one bad icon shows the
 * placeholder instead of taking down the screen. Tries again when the icon changes.
 */
class IconBoundary extends Component<AppIconProps & { icon: unknown; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(previous: { icon: unknown }): void {
    if (this.state.failed && previous.icon !== this.props.icon) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return <IconPlaceholder size={this.props.size} placeholderColor={this.props.placeholderColor} />;
    return this.props.children;
  }
}

/** An app's own icon, fetched from the computer. Shows a quiet voxel tile until it arrives. */
export const AppIcon = memo(function AppIcon(props: AppIconProps) {
  const icon = useLive((s) => s.icons[props.appId]);
  return (
    <IconBoundary {...props} icon={icon}>
      <ComputerIcon {...props} />
    </IconBoundary>
  );
});

/** What a key shows on its top face: a pixel symbol, an app's icon, or nothing. */
export function KeyIconView({ icon, size, color, shadow }: { icon: KeyIcon; size: number; color: string; shadow?: string }) {
  if (icon.kind === 'glyph') return <Glyph name={resolveGlyph(icon.name)} size={size} color={color} shadow={shadow} />;
  if (icon.kind === 'app') return <AppIcon appId={icon.appId} size={Math.round(size * 1.17)} placeholderColor="rgba(0,0,0,0.18)" />;
  return null;
}
