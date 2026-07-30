/**
 * The narration layer. One provider, one `<Announcer>`, one pure mapping table.
 *
 * A component that wants to say something imports {@link useAnnounce}. A component that wants
 * to render an `aria-live` region of its own is a defect — see `Announcer.tsx`.
 */

export { Announcer, DEFAULT_STEP_MS } from "./Announcer";
export type { AnnouncerProps } from "./Announcer";
export {
  AnnouncerContext,
  AnnouncerProvider,
  useAnnounce,
  useAnnouncer,
  useOptionalAnnounce,
} from "./AnnouncerContext";
export type { AnnouncerContextValue } from "./AnnouncerContext";
export { AnnouncementBus } from "./announcements";
export type {
  Announcement,
  AnnouncementDraft,
  AnnouncementListener,
  AnnouncementParams,
  Politeness,
} from "./announcements";
export { INTERRUPT_PHASE_KEYS, narrate } from "./narration";
export type { NarrationContext } from "./narration";
export { useEventNarration } from "./useEventNarration";
