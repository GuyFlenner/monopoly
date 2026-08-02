/**
 * Which half of the action bar is *the point* right now — one static table, keyed by phase.
 *
 * `ACTION_THEME[kind].zone` says where a command is filed. This says which of those two zones the
 * bar should have open when a phase is live, and it exists because a purely static demotion would
 * have been a new bug: in `DEBT_SETTLEMENT` mortgaging and selling are not "estate management you
 * can get to in a minute", they are the only alternative to leaving the game.
 * See `docs/UX_ACTION_PROMINENCE.md` §3.4.
 *
 * ## Reading a phase to decide how to draw is presentation
 *
 * This is the same line `game/presentation.ts` draws for Kids Mode, and it is worth restating
 * because the two sides look identical in a diff:
 *
 * - reading a projected field to decide **how to draw** is presentation — `presentationFor` already
 *   reads four of them;
 * - reading one to decide **what may be sent** is a rule, and would be a bug.
 *
 * `emphasisFor` is on the first side by construction: its output is handed to `useState` as an
 * *initial* value and to nothing else. The failure mode is the argument. If every entry below were
 * wrong, the estate zone would always begin folded — and every command inside it would still be
 * rendered, labelled, focusable, announced as a collapsed group, and one keystroke away. **There is
 * no value of this table that can make a legal move unreachable**, which is exactly what a
 * presentation table should be able to say about itself and a rule cannot.
 *
 * ## Why `debt_settlement` and `auction`, and nothing else
 *
 * Those two are the engine's `RAISING_PHASES` — the phases in which a player may raise cash but not
 * spend it (`phases.py`). This mirrors that reading; it does not import it, and it could not, since
 * a frozenset of Python enums is not on the wire. `DEBT_SETTLEMENT` is the obvious one.
 * `AUCTION` is included because the engine's own stated reason for opening sale and mortgage there
 * is "the bidder who needs to fund a bid" — a bidder who is short of cash, with the estate folded
 * away, is the same failure with a different name.
 *
 * The other nine emphasise `flow`, including `game_over` and the three transient phases, which offer
 * no commands at all and so emphasise nothing in practice. They are listed because
 * `Record<Phase, …>` is the coverage gate: a new phase in the engine regenerates the contract and
 * becomes a TypeScript error here, rather than silently inheriting `flow`.
 *
 * ## Not a catalogue of phase names
 *
 * Nothing here is rendered. `tests/test_key_contract.py` records `Phase` as a deliberately
 * *undisplayed* enum — a raw `awaiting_purchase_decision` inside a Hebrew sentence is GAP A5 — and
 * this table keeps that true: it maps a phase to a zone, never to a word.
 */

import type { ActionZone } from "./actions";
import type { Phase } from "../api/types";

/**
 * Which zone the phase makes the point.
 *
 * `Record<Phase, …>` is the coverage gate; `prominence.test.ts` re-checks it at runtime, because the
 * compile gate disappears the moment somebody widens the key type.
 */
export const PHASE_EMPHASIS: Readonly<Record<Phase, ActionZone>> = {
  awaiting_roll: "flow",
  jail_decision: "flow",
  moving: "flow",
  resolving_tile: "flow",
  awaiting_purchase_decision: "flow",
  // Raising: the bidder who needs to fund a bid (`phases.py` on `RAISING_PHASES`).
  auction: "portfolio",
  card_resolution: "flow",
  // Raising: sell and mortgage are the alternative to leaving the game.
  debt_settlement: "portfolio",
  trade_review: "flow",
  awaiting_end_turn: "flow",
  game_over: "flow",
};

/** The phases that put the estate front and centre, derived rather than restated. */
export const RAISING_EMPHASIS_PHASES: ReadonlySet<Phase> = new Set(
  (Object.keys(PHASE_EMPHASIS) as readonly Phase[]).filter(
    (phase) => PHASE_EMPHASIS[phase] === "portfolio",
  ),
);

/**
 * Which zone is the point, or `flow` when there is no phase yet.
 *
 * `undefined` — the first frame, or a caller with nothing to say — answers `flow`, the quieter
 * presentation. Safe by the argument in the docstring: a folded zone is still a reachable one.
 */
export function emphasisFor(phase: Phase | undefined): ActionZone {
  return phase === undefined ? "flow" : PHASE_EMPHASIS[phase];
}
