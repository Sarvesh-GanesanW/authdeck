/**
 * The one-row deck header keeps every control at its size; only the page tabs give up width. The
 * computer's block shows its name while the tabs keep at least the current page's segment, and
 * just its status light otherwise.
 */
export interface HeaderRoom {
  /** The tabs bar's width as laid out now. */
  tabs: number;
  /** The least the tabs bar needs: the current page's segment in full and a glimpse of the next. */
  need: number;
  /** Free width beside the tabs (tablets push the controls right with a spacer). */
  fill: number;
  /** The computer's block with its name. */
  full: number;
}

/**
 * Whether the computer's block shows only its light. Worked out from the room the tabs would have
 * with the name shown, so the answer is the same whichever form is on screen and never flips back
 * and forth. `dot` is the form on screen now; `control` is the light-only block's width. Null
 * until everything has been measured.
 */
export function pillDotOnly(room: HeaderRoom, dot: boolean, control: number): boolean | null {
  if (room.tabs <= 0 || room.need <= 0 || room.full <= 0) return null;
  const withName = room.tabs + room.fill - (dot ? room.full - control : 0);
  return withName < room.need;
}
