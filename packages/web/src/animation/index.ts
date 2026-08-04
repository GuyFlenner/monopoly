/**
 * The animation queue, as one import (MON-701, MON-709).
 *
 * Five beats, one subscription, and a timeline that can be reasoned about without a browser. The
 * layering is the one `a11y/` and `sound/` already use: a pure table (`timeline.ts`), a pure state
 * machine over an injected clock (`queue.ts`), a hook that subscribes once (`useAnimationQueue.ts`),
 * and presentational leaves that own no decisions (`Beat.tsx`, `SkipMotionButton.tsx`,
 * `FastForward.tsx`).
 *
 * The one rule for a caller: what comes out of `useAnimationQueue()` is an **override on
 * presentation**. Never gate a command, a figure or a legal move on it — see the docstring there.
 */

export { Pop, Pulse } from "./Beat";
export { FastForward } from "./FastForward";
export type { FastForwardProps } from "./FastForward";
export { MotionQueue, STILL } from "./queue";
export type { MotionFrame, MotionQueueOptions, RevealedCard } from "./queue";
export { SkipMotionButton } from "./SkipMotionButton";
export type { SkipMotionButtonProps } from "./SkipMotionButton";
export {
  cardFigure,
  compress,
  DEFAULT_BUDGET_MS,
  DEFAULT_DURATIONS,
  destinationOf,
  instantly,
  plan,
  readingAllowanceMs,
  stepFor,
  totalMs,
  walk,
} from "./timeline";
export type {
  BuildingPopStep,
  CardRevealStep,
  CashPulseStep,
  Deck,
  DiceSettleStep,
  PlanOptions,
  TimelineDurations,
  TimelineStep,
  TokenMoveStep,
} from "./timeline";
export {
  CARD_DWELL_STORAGE_KEY,
  cardDwellMs,
  clampCardSeconds,
  DEFAULT_CARD_SECONDS,
  forgetCachedCardSeconds,
  MAX_CARD_SECONDS,
  MIN_CARD_SECONDS,
  readCardSeconds,
  useCardDwellPreference,
  writeCardSeconds,
} from "./cardDwell";
export type { CardDwellPreference } from "./cardDwell";
export { isReplay, useAnimationQueue } from "./useAnimationQueue";
export type { AnimationQueueOptions, AnimationState } from "./useAnimationQueue";
