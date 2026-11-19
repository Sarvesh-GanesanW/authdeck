/** What the desktop app needs from the running agent to open and close pairing. */
export interface PairingControl {
  isOpen(): boolean;
  open(): void;
  close(): void;
}

/**
 * Keeps the agent's pairing window in step with the pairing view: the PIN and QR code work only
 * while that view is on screen. Opened when it shows, closed when it hides or the view changes.
 * When the window runs out while the view shows, it stays closed until asked (openAgain) or the
 * view is shown anew. Only a window this app opened is closed from here.
 */
export class PairingSync {
  /** This app opened the window that is (or was) showing. */
  private opened = false;
  /** The window ran out, or could not be opened, while the view showed. */
  private ranOut = false;

  private readonly onError: (message: string) => void;

  constructor(onError: (message: string) => void = () => {}) {
    this.onError = onError;
  }

  /** Returns true when it changed the window; the agent's event then publishes the new state. */
  sync(agent: PairingControl, onScreen: boolean, showsPairing: boolean): boolean {
    const isOpen = agent.isOpen();
    if (!onScreen || !showsPairing) {
      const close = this.opened && isOpen;
      this.opened = false;
      this.ranOut = false;
      if (!close) return false;
      try {
        agent.close();
        return true;
      } catch (err) {
        // The agent closes it when it runs out anyway.
        this.onError(`Could not close pairing: ${(err as Error).message}`);
        return false;
      }
    }
    if (this.opened && !isOpen) {
      this.opened = false;
      this.ranOut = true;
    }
    if (this.opened || this.ranOut) return false;
    return this.open(agent);
  }

  /** The "New PIN" or "Open pairing" button. */
  openAgain(agent: PairingControl, onScreen: boolean): void {
    if (!onScreen) return;
    this.ranOut = false;
    this.open(agent);
  }

  private open(agent: PairingControl): boolean {
    // Set first: opening publishes state, which comes back here before open() returns.
    this.opened = true;
    try {
      agent.open();
      return true;
    } catch (err) {
      // Shown as closed, with the button to try again.
      this.opened = false;
      this.ranOut = true;
      this.onError(`Could not open pairing: ${(err as Error).message}`);
      return false;
    }
  }
}
