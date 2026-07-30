/**
 * Sound cues, as one import (MON-706).
 *
 * Four cues, one switch that remembers itself, and a port so that no test ever has to listen. The
 * layering is the same one `a11y/` uses: a pure table (`cues.ts`), a hook that subscribes once
 * (`useSoundCues.ts`), and an adapter to the platform (`audioPort.ts`).
 */

export {
  browserAudioContext,
  createWebAudioPort,
  defaultAudioPort,
  MAX_CUE_SECONDS,
  SILENT_PORT,
} from "./audioPort";
export type { AudioContextFactory, AudioContextLike, AudioPort } from "./audioPort";

export { cueFor, CUES } from "./cues";
export type { CueName } from "./cues";

export {
  DEFAULT_MUTED,
  forgetCachedMute,
  MUTE_STORAGE_KEY,
  readMuted,
  useMutePreference,
  writeMuted,
} from "./mute";
export type { MutePreference } from "./mute";

export { MuteToggle } from "./MuteToggle";
export type { MuteToggleProps } from "./MuteToggle";

export { useSoundCues } from "./useSoundCues";
