/**
 * Where a sheet's body was scrolled before the keyboard came up, so it can go back there when the
 * keyboard hides. Only the first show counts: moving between fields while the keyboard stays up
 * changes the overlap but not where the body started.
 */
export class KeyboardScrollMemory {
  private before: number | null = null;

  /** The keyboard covers `overlap` now; `scrollY` is the body's offset at that moment. */
  overlapChanged(overlap: number, scrollY: number): { restoreTo: number } | null {
    if (overlap > 0) {
      if (this.before === null) this.before = scrollY;
      return null;
    }
    if (this.before === null) return null;
    const restoreTo = this.before;
    this.before = null;
    return { restoreTo };
  }
}
