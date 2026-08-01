/**
 * The push side of the narration: `useAnnounce()`.
 *
 * Any component that has something to say calls this. What it must **not** do is render its own
 * `aria-live` region — two regions announcing one dice roll is double-speak, and it was about to
 * be built twice (MON-404's dice tray and MON-407's event log, GAP G-54). There is one
 * `<Announcer>` at the root and this is how you reach it.
 *
 * The context value is stable for the provider's lifetime, so pushing an announcement never
 * re-renders the subtree.
 */

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

import { AnnouncementBus, type AnnouncementDraft } from "./announcements";

export interface AnnouncerContextValue {
  readonly bus: AnnouncementBus;
  /** Say one thing, or several in order. Returns nothing: narration is fire-and-forget. */
  readonly announce: (drafts: AnnouncementDraft | readonly AnnouncementDraft[]) => void;
}

export const AnnouncerContext = createContext<AnnouncerContextValue | null>(null);

export function AnnouncerProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const bus = useRef<AnnouncementBus | null>(null);
  bus.current ??= new AnnouncementBus();
  const held = bus.current;

  const value = useMemo<AnnouncerContextValue>(
    () => ({
      bus: held,
      announce: (drafts) => {
        held.push(
          Array.isArray(drafts)
            ? (drafts as readonly AnnouncementDraft[])
            : [drafts as AnnouncementDraft],
        );
      },
    }),
    [held],
  );

  return <AnnouncerContext.Provider value={value}>{children}</AnnouncerContext.Provider>;
}

export function useAnnouncer(): AnnouncerContextValue {
  const context = useContext(AnnouncerContext);
  if (context === null) {
    throw new Error("useAnnounce must be rendered inside an <AnnouncerProvider>");
  }
  return context;
}

export function useAnnounce(): AnnouncerContextValue["announce"] {
  return useAnnouncer().announce;
}

/** Discards its announcements. The value {@link useOptionalAnnounce} returns with no provider. */
const SILENT: AnnouncerContextValue["announce"] = () => undefined;

/**
 * `announce`, or a no-op when there is no `<AnnouncerProvider>` above.
 *
 * For **presentational leaves only** — the empty, loading and error states in
 * `panels/States.tsx` (MON-708). Those are rendered by every panel in the product and also, in a
 * component test, entirely on their own; a loading placeholder that throws unless the whole app
 * shell is mounted around it would push every panel's three-state test into an integration test,
 * and the announcement is the part of it least worth that price.
 *
 * Everything with something of its own to say keeps {@link useAnnounce}, which throws. The
 * distinction is deliberate: a *narrator* with no region to speak into is a defect, and silence
 * would hide it. A spinner is not a narrator.
 */
export function useOptionalAnnounce(): AnnouncerContextValue["announce"] {
  return useContext(AnnouncerContext)?.announce ?? SILENT;
}
