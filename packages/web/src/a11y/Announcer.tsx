/**
 * The one `<Announcer>`. Two live regions in the whole product, and this file owns both.
 *
 * * **polite** — dice, movement, rent, money. Said when the listener is between sentences.
 * * **assertive** — the moments the acting player changes: a turn starting, an interrupt phase
 *   taking over the table. Interrupting for anything else makes the game unlistenable.
 *
 * The queue is **serialized**: one message is placed in a region, held for `stepMs`, and then
 * replaced by the next. That dwell is the point. A screen reader announces a live region when
 * its content changes, and content that changes three times in one tick is announced once, or
 * not at all — which is how a rent payment silently disappears behind the dice roll that caused
 * it. Two events in one command therefore produce two announcements, in order, in one region.
 *
 * Nothing blocks on this. The bus never waits for a region to be free (see `announcements.ts`),
 * a player can act while a sentence is still being read, and no other component may render an
 * `aria-live` region of its own (GAP D1/D2/D3, G-54) — with one documented exception.
 *
 * ## The one exception: `local/LocalEngineGate.tsx`
 *
 * The Pyodide loading screen (MON-805) has its own `aria-live="polite"` stage line, and it is
 * sanctioned rather than removed (MON-745). The reason ordinary components cannot do this is that
 * a second region and this one would both be live at once, so the same event gets announced
 * twice, or two unrelated sentences interleave in one listener's ear. That failure needs two
 * regions *at the same time*, and the gate's cannot be one of them: it renders before `<App>`
 * exists at all, which is also before `<AnnouncerProvider>` and this component exist — see
 * `shell.tsx` and `App.tsx`, where `<LocalEngineGate>` wraps `<App>` rather than the reverse. The
 * gate hands off to `children(client)` — `<App>`, with this `<Announcer>` inside it — the instant
 * loading finishes, and renders nothing of its own from that point on. So the two live regions
 * are never both mounted; `local/localTransport.test.tsx`'s "the loading gate" suite (MON-745)
 * asserts exactly that, by counting `[aria-live]` nodes through both phases, and is the thing to
 * make red before touching either file's narration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Announcement, AnnouncementBus, Politeness } from "./announcements";
import { useAnnouncer } from "./AnnouncerContext";

/**
 * How long one sentence holds its region before the next replaces it.
 *
 * Long enough that a screen reader starts speaking before the text changes under it, short
 * enough that a five-event turn is not still narrating when the next player rolls.
 */
export const DEFAULT_STEP_MS = 1200;

export interface AnnouncerProps {
  readonly stepMs?: number;
}

export function Announcer({ stepMs = DEFAULT_STEP_MS }: AnnouncerProps): React.JSX.Element {
  const { bus } = useAnnouncer();
  const polite = useSerializedRegion(bus, "polite", stepMs);
  const assertive = useSerializedRegion(bus, "assertive", stepMs);

  return (
    <>
      {/*
        `sr-only` rather than `hidden`: a region a browser considers invisible is a region an
        assistive technology may ignore. No physical CSS property appears here, and none can —
        text that is not on screen has no side to be on.
      */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-announcer="polite">
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only" data-announcer="assertive">
        {assertive}
      </div>
    </>
  );
}

/**
 * The current sentence for one region, advanced one announcement at a time.
 *
 * The pending list is a ref rather than state: appending to it must not re-render, and the
 * render that matters is the one that changes `current`.
 */
function useSerializedRegion(bus: AnnouncementBus, politeness: Politeness, stepMs: number): string {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<Announcement | null>(null);
  const pending = useRef<Announcement[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const advance = useCallback(() => {
    const next = pending.current.shift();
    if (next === undefined) {
      timer.current = null;
      // Clearing the region matters: an identical sentence later is a *change* only if
      // something else stood here in between.
      setCurrent(null);
      return;
    }
    setCurrent(next);
    timer.current = setTimeout(advance, stepMs);
  }, [stepMs]);

  useEffect(
    () =>
      bus.subscribe((added) => {
        const mine = added.filter((announcement) => announcement.politeness === politeness);
        if (mine.length === 0) {
          return;
        }
        pending.current.push(...mine);
        if (timer.current === null) {
          advance();
        }
      }),
    [bus, politeness, advance],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  return current === null ? "" : t(current.key, current.params);
}
