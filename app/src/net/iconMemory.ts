/**
 * Which of a computer's icons stay in memory. Each icon may be up to MAX_ICON_BASE64_CHARS, and a
 * computer lists up to LIMITS.apps apps, so scrolling the app picker could hold hundreds of
 * megabytes. Past the budget, the icons used longest ago are dropped; one that is drawn again loads
 * from the computer (or its saved cache) again. Icons on screen are held and never dropped, so a
 * screen of icons larger than the budget doesn't drop and reload its own icons in a loop.
 */
import type { AppIcon } from '../protocol';

/** About 8 MB of base64 in memory, besides the icons on screen. */
export const MAX_LIVE_ICON_CHARS = 8_000_000;

const iconChars = (icon: AppIcon | null): number => (icon ? icon.data.length + icon.mime.length : 0);

export class IconMemory {
  /** When each app id was last shown or stored, on a counter. */
  private readonly lastUsed = new Map<string, number>();
  /** How many mounted views show each app id. */
  private readonly holds = new Map<string, number>();
  private clock = 0;

  constructor(private readonly budgetChars = MAX_LIVE_ICON_CHARS) {}

  /** A view shows `appId`'s icon: it stays until the returned release is called. */
  hold(appId: string): () => void {
    this.holds.set(appId, (this.holds.get(appId) ?? 0) + 1);
    this.touch(appId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(appId) ?? 1) - 1;
      if (left > 0) this.holds.set(appId, left);
      else this.holds.delete(appId);
      this.touch(appId);
    };
  }

  /** Another computer: what was used before says nothing about its icons. Holds stay (they are views). */
  reset(): void {
    this.lastUsed.clear();
  }

  /**
   * The ids to drop from `icons` (the whole map about to be live) to bring it within the budget:
   * those not on screen, least recently used first. `stored` ids count as used now.
   */
  evictions(icons: Readonly<Record<string, AppIcon | null>>, stored: Iterable<string>): string[] {
    for (const id of stored) this.touch(id);
    const ids = Object.keys(icons);
    let total = 0;
    for (const id of ids) total += iconChars(icons[id]!);
    for (const id of [...this.lastUsed.keys()]) if (!Object.prototype.hasOwnProperty.call(icons, id)) this.lastUsed.delete(id);
    if (total <= this.budgetChars) return [];
    const byAge = ids.filter((id) => !this.holds.has(id)).sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    const dropped: string[] = [];
    for (const id of byAge) {
      if (total <= this.budgetChars) break;
      const chars = iconChars(icons[id]!);
      if (chars === 0) continue;
      total -= chars;
      dropped.push(id);
      this.lastUsed.delete(id);
    }
    return dropped;
  }

  private touch(appId: string): void {
    this.lastUsed.delete(appId);
    this.lastUsed.set(appId, ++this.clock);
  }
}
