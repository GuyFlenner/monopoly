/**
 * The replay viewer, as one import (MON-705).
 *
 * `<ReplayButton>` is the whole public surface: it opens the panel, the panel fetches its own copy of
 * the event log, and nothing outside this directory needs to know either of those things. The
 * accumulator is exported too, because it is pure and it is where the feature's honesty lives — a
 * reader asking "how can a rules-free UI draw a past frame?" should be able to read `replayFacts.ts`
 * without unpicking a component.
 */

export { ReplayBoard } from "./ReplayBoard";
export type { ReplayBoardProps } from "./ReplayBoard";
export { ReplayButton } from "./ReplayButton";
export type { ReplayButtonProps } from "./ReplayButton";
export { ReplayControls } from "./ReplayControls";
export type { ReplayControlsProps } from "./ReplayControls";
export { ReplayPanel } from "./ReplayPanel";
export type { ReplayPanelProps } from "./ReplayPanel";
export { factsAt, foldEvent, NOTHING_STATED, seatFacts, squareFacts } from "./replayFacts";
export type { DiceFacts, ReplayFacts, SeatFacts, SquareFacts } from "./replayFacts";
export { useTileName } from "./tileNames";
export type { TileNameLookup } from "./tileNames";
