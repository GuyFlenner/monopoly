/**
 * The wire between the event stream and the speaker (MON-706).
 *
 * Called once, from whatever renders a live game — the same shape and the same single-subscription
 * discipline as `useEventNarration`. It reads the **same de-duplicated feed** the Announcer reads
 * (`useEventFeed`, which is the queue's own cursor), so a reconnect's replayed backlog does not
 * replay its sounds, and no component anywhere else handles an event in order to make a noise.
 * That is the point of putting it here: a `<DiceTray>` that played its own click would sound twice
 * for a roll the queue delivered once, and would be silent for a roll that arrived over the socket.
 *
 * ## What it does not do
 *
 * It does not wait. `port.play` returns `void` by contract (`audioPort.ts`), the feed calls this
 * listener synchronously from `offer`, and nothing here awaits, schedules or retries. An animation,
 * an announcement and a click all outrank a sound effect.
 *
 * It does not decide. Which cue an event makes is `cueFor`'s answer, and whether the game is muted
 * is the store's. This composes the two.
 */

import { useEventFeed } from "@/game";

import { defaultAudioPort, type AudioPort } from "./audioPort";
import { cueFor } from "./cues";
import { useMutePreference } from "./mute";

/**
 * Play a cue for every event that arrives, unless the player has muted the game.
 *
 * @param port Where the cues go. Defaults to the module-level Web Audio port; a test passes a
 *   recording fake, which is the only honest way to assert that a roll made a sound.
 */
export function useSoundCues(port: AudioPort = defaultAudioPort()): void {
  const { muted } = useMutePreference();

  useEventFeed((frames) => {
    // Checked inside the listener rather than by skipping the subscription: `useEventFeed` holds the
    // listener in a ref precisely so a re-render does not unsubscribe, and an unsubscribe between
    // two frames of one command would drop the second. Muting must silence the game, not perturb
    // the feed.
    if (muted) {
      return;
    }
    for (const frame of frames) {
      const cue = cueFor(frame.event);
      if (cue !== null) {
        port.play(cue);
      }
    }
  });
}
