/**
 * Mechanical key sounds, respecting the user's setting. The files come from
 * scripts/gen-sounds.mjs. Sound is decoration: if a player fails, the press goes on silently.
 */
import { type AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio';

import { useStore } from '../state/store';

const KEY_DOWN = [
  require('../../assets/sounds/key-down-1.wav'),
  require('../../assets/sounds/key-down-2.wav'),
  require('../../assets/sounds/key-down-3.wav'),
];
const KEY_UP = [
  require('../../assets/sounds/key-up-1.wav'),
  require('../../assets/sounds/key-up-2.wav'),
  require('../../assets/sounds/key-up-3.wav'),
];
const TICK = [require('../../assets/sounds/tick.wav')];

/** Players per sound, so fast presses overlap instead of cutting each other off. */
const POOL_SIZE = 6;
const KEY_VOLUME = 0.55;
const TICK_VOLUME = 0.35;

/** A player in a ring, and whether it's waiting at the start of its sound. */
interface Slot {
  player: AudioPlayer;
  rewound: boolean;
}

/**
 * A ring of players cycling through a sound's variations. Each player rewinds as soon as
 * it finishes, so a press only has to start it: seeking first (slow on Android's ExoPlayer)
 * would make every click late.
 */
class Voice {
  private slots: Slot[] = [];
  private next = 0;

  constructor(
    private readonly sources: number[],
    private readonly volume: number,
  ) {}

  load() {
    if (this.slots.length > 0) return;
    for (let i = 0; i < POOL_SIZE; i++) {
      const player = createAudioPlayer(this.sources[i % this.sources.length]);
      player.volume = this.volume;
      const slot: Slot = { player, rewound: true };
      player.addListener('playbackStatusUpdate', (status) => {
        if (!status.didJustFinish) return;
        // ExoPlayer still wants to play after it ends, so a bare rewind would replay the sound.
        player.pause();
        player
          .seekTo(0)
          .then(() => {
            slot.rewound = true;
          })
          .catch(() => undefined);
      });
      this.slots.push(slot);
    }
  }

  play() {
    const slot = this.slots[this.next];
    if (!slot) return;
    this.next = (this.next + 1) % this.slots.length;
    // A player still sounding (very fast presses) restarts, as it always did.
    if (!slot.rewound) slot.player.seekTo(0).catch(() => undefined);
    slot.rewound = false;
    slot.player.play();
  }
}

const voices = {
  keyDown: new Voice(KEY_DOWN, KEY_VOLUME),
  keyUp: new Voice(KEY_UP, KEY_VOLUME),
  tick: new Voice(TICK, TICK_VOLUME),
};

function play(voice: Voice) {
  if (!useStore.getState().settings.keySounds) return;
  try {
    voice.play();
  } catch {
    // A broken audio session must never break a key press.
  }
}

export const sounds = {
  /** Creates every player up front so the first press isn't late. Call once at startup. */
  load() {
    // Mix with the user's music, and stay quiet when the iOS silent switch is on.
    setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' }).catch(() => undefined);
    try {
      Object.values(voices).forEach((v) => v.load());
    } catch {
      // Without players every play() is a no-op.
    }
  },
  keyDown: () => play(voices.keyDown),
  keyUp: () => play(voices.keyUp),
  /** Small controls: tabs, buttons, switches. */
  tick: () => play(voices.tick),
};
