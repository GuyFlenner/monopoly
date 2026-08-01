/**
 * The seam between "a cue happened" and "a speaker moved".
 *
 * ## Why there is a port at all
 *
 * Because a test must never assert on audio. There is no way to read what a browser played that is
 * not either flaky or a re-implementation of the Web Audio API, and a suite that tries becomes the
 * suite everyone reruns until it goes green. So the *decision* is a pure function (`cues.ts`), the
 * *policy* is a hook over an injected {@link AudioPort} (`useSoundCues.ts`), and the noise is here,
 * behind an interface with four method calls in it — asserted as calls, never as sound.
 *
 * ## Why the sound is synthesized
 *
 * No binary assets and no network requests: a `.mp3` per cue is four files to license, four files
 * to cache, and four files that are silent until they have loaded — so the first roll of every
 * session would be the one that made no sound. Four oscillators with short envelopes need nothing
 * but the browser, cost a few hundred bytes of source, and are audible on the first cue.
 *
 * The tones are deliberately plain: a short pair of clicks for the dice, a bright two-note rise for
 * money, a fuller chord for a purchase, and a low pair for jail. Each is under 300 ms, because a
 * cue that is still playing when the next event arrives is a cue that turns a five-event turn into
 * a chord nobody chose.
 *
 * ## Autoplay, and the thing that has to be got right
 *
 * A browser will not let a page make a noise before the user has interacted with it, and an
 * `AudioContext` constructed too early is a context stuck in `suspended` for the rest of the
 * session. Two consequences, both handled below:
 *
 * 1. The context is created **lazily, on the first cue**, not at import time.
 * 2. `resume()` is called and **never awaited**. That is the whole of "never block": a cue is
 *    fire-and-forget, the promise is dropped, and if the browser refuses then the cue is simply
 *    not heard. Nothing upstream waits, retries, or reports it — an animation, an announcement and
 *    a click are all more important than a sound effect, and an `await` here is how a dropped
 *    permission becomes a frozen board.
 *
 * Nothing in this file can throw into a caller: every entry point is wrapped, because a
 * `SecurityError` from an audio API must not be able to take a turn down with it.
 */

import type { CueName } from "./cues";

/**
 * Somewhere a cue can be sent. Four cues in, no answers out.
 *
 * `play` returns `void`, not a promise, and that is the contract rather than an oversight: a
 * caller must have nothing to await and nothing to handle.
 */
export interface AudioPort {
  play(cue: CueName): void;
}

/** The subset of `AudioContext` used here, so a fake needs four members rather than forty. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state: string;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  resume(): Promise<void>;
}

export type AudioContextFactory = () => AudioContextLike | null;

/** One tone: when it starts, what pitch, how loud, how long. Times are offsets in seconds. */
interface Tone {
  readonly at: number;
  readonly hz: number;
  readonly gain: number;
  readonly seconds: number;
  readonly wave: OscillatorType;
}

/**
 * The four cues as tone lists.
 *
 * Pitches are ordinary equal-temperament notes so the four cues sit in one key rather than
 * clashing when two land in the same second. Gains are low — 0.08 peak — because this plays over
 * whatever else is on the device, and a game that is louder than the music is a game that gets
 * muted once and never unmuted.
 */
const SCORE: Readonly<Record<CueName, readonly Tone[]>> = {
  // Two dry clicks, a beat apart: two dice landing.
  dice: [
    { at: 0, hz: 320, gain: 0.06, seconds: 0.05, wave: "triangle" },
    { at: 0.08, hz: 260, gain: 0.06, seconds: 0.05, wave: "triangle" },
  ],
  // A rising fifth. Money moved; which way is the Announcer's to say, not the speaker's.
  cash: [
    { at: 0, hz: 660, gain: 0.05, seconds: 0.07, wave: "sine" },
    { at: 0.07, hz: 990, gain: 0.05, seconds: 0.1, wave: "sine" },
  ],
  // A major triad, arpeggiated: something changed hands, and it is good news for somebody.
  purchase: [
    { at: 0, hz: 523, gain: 0.05, seconds: 0.08, wave: "sine" },
    { at: 0.07, hz: 659, gain: 0.05, seconds: 0.08, wave: "sine" },
    { at: 0.14, hz: 784, gain: 0.06, seconds: 0.14, wave: "sine" },
  ],
  // Two low notes, falling. The one cue allowed to sound like a consequence.
  jail: [
    { at: 0, hz: 220, gain: 0.07, seconds: 0.12, wave: "square" },
    { at: 0.12, hz: 165, gain: 0.07, seconds: 0.18, wave: "square" },
  ],
};

/** The longest cue, so nothing above has to guess how long a scheduled tone lives. */
export const MAX_CUE_SECONDS = 0.32;

/**
 * The browser's own `AudioContext`, or `null` where there is none.
 *
 * `null` in jsdom, in a server render, and in a browser old enough to lack the constructor — all
 * three are "no sound", which is a state this product is entirely playable in.
 */
export function browserAudioContext(): AudioContextLike | null {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext;
  if (Ctor === undefined) {
    return null;
  }
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * An {@link AudioPort} that synthesizes its cues, creating its context on the first one.
 *
 * The factory is a parameter so a test can supply a recording fake and drive the real scheduling
 * code, rather than mocking this module out and testing nothing.
 */
export function createWebAudioPort(factory: AudioContextFactory = browserAudioContext): AudioPort {
  let context: AudioContextLike | null = null;
  let tried = false;

  return {
    play: (cue) => {
      if (!tried) {
        tried = true;
        context = factory();
      }
      if (context === null) {
        return;
      }
      // Deliberately not awaited, and deliberately not conditional on succeeding. See the module
      // docstring: a cue never blocks and never reports.
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
      try {
        schedule(context, SCORE[cue]);
      } catch {
        // A browser that refuses to schedule is a browser this game is silent in. It is not a
        // browser this game is broken in, so the failure stops here.
      }
    },
  };
}

/**
 * Lay one cue's tones onto the context's timeline.
 *
 * Each tone gets its own oscillator and gain node, started and stopped at an absolute time, with a
 * short attack and an exponential release. The attack matters: a gain that jumps from 0 to full in
 * one sample is a click, and four cues of clicks is what makes synthesized audio sound cheap.
 *
 * `stop()` is what disposes of the nodes — an `OscillatorNode` is single-use and is collected once
 * it has stopped — so nothing here has to be torn down and there is no handle to leak.
 */
function schedule(context: AudioContextLike, tones: readonly Tone[]): void {
  const now = context.currentTime;
  for (const tone of tones) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const start = now + tone.at;
    const end = start + tone.seconds;

    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.hz, start);

    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(tone.gain, start + 0.008);
    // Exponential, and to a small positive value rather than zero: `exponentialRampToValueAtTime`
    // is undefined at zero, and 0.0001 is inaudible.
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(envelope);
    envelope.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);
  }
}

/** A port that plays nothing. What a muted game and a test that wants silence both use. */
export const SILENT_PORT: AudioPort = { play: () => undefined };

let shared: AudioPort | null = null;

/**
 * The one port the product uses, created on first ask.
 *
 * A module-level singleton rather than a value in a provider, for the reason `board/motion.ts`
 * gives about its own store: an `AudioContext` per component is a browser resource per component,
 * and browsers cap how many a page may hold. Lazily, because constructing one at import time is
 * the autoplay mistake described above — a module is imported long before anybody has clicked.
 */
export function defaultAudioPort(): AudioPort {
  shared ??= createWebAudioPort();
  return shared;
}
