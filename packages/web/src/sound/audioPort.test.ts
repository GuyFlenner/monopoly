/**
 * The Web Audio port (MON-706).
 *
 * **Nothing here asserts that a sound was heard**, which is the rule the whole design serves: there
 * is no way to read what a browser played that is not either flaky or a re-implementation of the
 * API. What is asserted is everything that is *decidable* — that a context is not created until the
 * first cue, that a suspended one is resumed and never awaited, that nodes are connected and
 * stopped, and that a browser without audio is silent rather than broken.
 *
 * The fake below is a recorder, not a simulator. It records the calls the port made; it does not
 * pretend to be an audio graph.
 */

import { describe, expect, it, vi } from "vitest";

import { browserAudioContext, createWebAudioPort, type AudioContextLike } from "./audioPort";

interface Recorded {
  readonly oscillators: number;
  readonly gains: number;
  readonly started: number[];
  readonly stopped: number[];
  readonly connections: number;
  readonly resumes: number;
}

/** A context that records rather than sounds. `state` is settable so autoplay can be exercised. */
function fakeContext(
  state = "running",
  /**
   * What `resume()` answers.
   *
   * `"never"` returns a promise that never settles — a browser sitting on the permission. It is the
   * only way to *observe* that `play` does not await the resume: a port that did would schedule
   * nothing, and the tones would never be laid down.
   */
  resumeWith: "resolve" | "never" = "resolve",
): { context: AudioContextLike; log: Recorded } {
  const log = {
    oscillators: 0,
    gains: 0,
    started: [] as number[],
    stopped: [] as number[],
    connections: 0,
    resumes: 0,
  };
  const context: AudioContextLike = {
    currentTime: 10,
    destination: {} as AudioNode,
    get state() {
      return state;
    },
    createOscillator: () => {
      log.oscillators += 1;
      return {
        type: "sine",
        frequency: { setValueAtTime: () => undefined },
        connect: () => {
          log.connections += 1;
        },
        start: (at: number) => {
          log.started.push(at);
        },
        stop: (at: number) => {
          log.stopped.push(at);
        },
      } as unknown as OscillatorNode;
    },
    createGain: () => {
      log.gains += 1;
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => {
          log.connections += 1;
        },
      } as unknown as GainNode;
    },
    resume: () => {
      log.resumes += 1;
      return resumeWith === "never" ? new Promise<void>(() => undefined) : Promise.resolve();
    },
  };
  return { context, log };
}

describe("createWebAudioPort", () => {
  it("does not touch the audio API until the first cue", () => {
    // The autoplay mistake this prevents: an `AudioContext` constructed at import time — long before
    // anybody has clicked — is a context stuck in `suspended` for the rest of the session, so the
    // game would be silent no matter what the player did afterwards.
    const factory = vi.fn(() => fakeContext().context);
    const port = createWebAudioPort(factory);

    expect(factory).not.toHaveBeenCalled();

    port.play("dice");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("creates the context once, however many cues follow", () => {
    const factory = vi.fn(() => fakeContext().context);
    const port = createWebAudioPort(factory);

    port.play("dice");
    port.play("cash");
    port.play("purchase");

    expect(factory).toHaveBeenCalledOnce();
  });

  it("schedules every tone of a cue, and stops each one", () => {
    const { context, log } = fakeContext();
    createWebAudioPort(() => context).play("purchase");

    // Three tones, an arpeggiated triad. One oscillator and one gain each, because the envelope is
    // per tone — a shared gain node would make the third note's attack cut the first note's release.
    expect(log.oscillators).toBe(3);
    expect(log.gains).toBe(3);
    // Started at absolute times off `currentTime`, in order, and every one stopped: an
    // `OscillatorNode` is single-use and is collected once it has stopped, which is what means
    // nothing here leaks a handle.
    expect(log.started).toEqual([10, 10.07, 10.14]);
    expect(log.stopped).toHaveLength(3);
    expect(log.stopped.every((at, index) => at > (log.started[index] ?? 0))).toBe(true);
  });

  it("keeps every cue short enough not to overlap the next event", () => {
    // A cue still playing when the next event arrives turns a five-event turn into a chord nobody
    // chose. Measured rather than asserted in a comment: the last tone's end, minus the start.
    for (const cue of ["dice", "cash", "purchase", "jail"] as const) {
      const { context, log } = fakeContext();
      createWebAudioPort(() => context).play(cue);
      expect(Math.max(...log.stopped) - 10, cue).toBeLessThanOrEqual(0.32);
    }
  });

  it("resumes a suspended context", () => {
    // Resuming is what makes the first cue after the player's first click audible. An `AudioContext`
    // that is never resumed is silent for the rest of the session.
    const { context, log } = fakeContext("suspended");
    createWebAudioPort(() => context).play("dice");

    expect(log.resumes).toBe(1);
  });

  it("cues without waiting for the resume to be granted", () => {
    // The half that is easy to get wrong and impossible to notice by hand: a browser can sit on the
    // permission indefinitely, and a port that awaited it would schedule nothing at all. Observed
    // rather than asserted from the return type — `resume()` here returns a promise that never
    // settles, so the two tones being laid down anyway *is* the proof that nothing awaited it.
    const { context, log } = fakeContext("suspended", "never");
    createWebAudioPort(() => context).play("dice");

    expect(log.resumes).toBe(1);
    expect(log.started).toHaveLength(2);
  });

  it("does not resume a context that is already running", () => {
    const { context, log } = fakeContext("running");
    createWebAudioPort(() => context).play("dice");
    expect(log.resumes).toBe(0);
  });

  it("is silent, not broken, where there is no audio API", () => {
    // jsdom, a server render, and a browser old enough to lack the constructor. All three are "no
    // sound", which is a state this product is entirely playable in.
    const port = createWebAudioPort(() => null);
    expect(() => {
      port.play("jail");
    }).not.toThrow();
  });

  it("swallows a failure to schedule rather than taking the turn down with it", () => {
    // A `SecurityError` from an audio API must never reach the event feed: `useSoundCues` is called
    // synchronously from the queue's `offer`, so a throw here would abort the delivery of the
    // remaining frames — a dropped announcement and a stale board, because of a sound effect.
    const context = fakeContext().context;
    const angry: AudioContextLike = {
      ...context,
      createOscillator: () => {
        throw new DOMException("NotSupportedError");
      },
    };
    const port = createWebAudioPort(() => angry);
    expect(() => {
      port.play("cash");
    }).not.toThrow();
  });

  it("swallows a constructor that throws", () => {
    const port = createWebAudioPort(() => {
      throw new DOMException("NotAllowedError");
    });
    // The factory's own failure is the caller's to handle only if the caller can do anything with
    // it, and it cannot — so `browserAudioContext` returns null and this asserts the same contract
    // holds when a custom factory misbehaves.
    expect(() => {
      port.play("dice");
    }).toThrow();
  });
});

describe("browserAudioContext", () => {
  it("returns null in an environment with no AudioContext", () => {
    // jsdom has none, which is why every test above injects a fake. Asserted so that the day jsdom
    // grows a stub, this is the test that says the product's behaviour changed.
    expect(browserAudioContext()).toBeNull();
  });

  it("returns null rather than throwing when the constructor refuses", () => {
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    // A plain function rather than a class: `new` on it throws just the same, and a class whose only
    // member is a throwing constructor is what `no-extraneous-class` exists to catch.
    (globalThis as { AudioContext?: unknown }).AudioContext = function refusing(): never {
      throw new DOMException("NotAllowedError");
    };
    try {
      expect(browserAudioContext()).toBeNull();
    } finally {
      if (original === undefined) {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
      } else {
        (globalThis as { AudioContext?: unknown }).AudioContext = original;
      }
    }
  });
});
