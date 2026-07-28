/**
 * Subscribe to *new* event frames, exactly once each.
 *
 * The narration (MON-411) and the animation script (MON-701) both need "what just happened",
 * not "everything that has ever happened", and neither should be re-implementing the
 * de-duplication the queue already owns — two consumers each keeping their own idea of a
 * cursor is how one roll gets announced twice.
 *
 * The listener is called with the frames the queue accepted, in `seq` order. It is called
 * synchronously from `offer`, so it must be cheap: push onto your own queue and return. It
 * must never await anything the socket is waiting on, and the queue will not wait for it in
 * any case (see `api/eventQueue.ts`).
 */

import { useEffect, useRef } from "react";

import type { LoggedEvent } from "@/api";

import { useGameContext } from "./useGame";

export type EventFeedListener = (frames: readonly LoggedEvent[]) => void;

export function useEventFeed(listener: EventFeedListener): void {
  const { queue } = useGameContext();
  // The listener is almost always an inline closure over fresh props. Holding it in a ref
  // means a re-render does not unsubscribe and resubscribe — and an unsubscribe between two
  // frames of one command would drop the second.
  const held = useRef(listener);
  held.current = listener;

  useEffect(
    () =>
      queue.subscribe((frames) => {
        held.current(frames);
      }),
    [queue],
  );
}
