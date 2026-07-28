/**
 * One event in, zero or more announcements out. A pure function, no React, no i18next.
 *
 * The narration is a **presentation table**, not a rule: it decides which sentence describes
 * an event and which region says it. It never decides *whether* the event happened, computes a
 * figure the event does not carry, or infers a consequence. Every number below is copied
 * straight off the wire — `RentCharged.amount`, `CashChanged.delta`, `DiceRolled.total` — which
 * is exactly why ADR-008 made the events self-contained (G-36). If a sentence needs a number
 * no event carries, the answer is a contract gap, not an expression here.
 *
 * Money is passed through as a raw integer. There is no currency formatter anywhere in this
 * package yet (GAP G-43 records that); when `{{amount, money}}` lands, these params are already
 * the right values in the right places.
 */

import type { GameEvent, Phase } from "@/api";

import type { AnnouncementDraft } from "./announcements";

export interface NarrationContext {
  /** A seat's display name. A lookup in `state.players`, never a derivation. */
  readonly playerName: (playerId: number) => string;
  /** A tile's translated name, from `board.tiles[index].name_key`. */
  readonly tileName: (tileIndex: number) => string;
}

/**
 * Phases worth interrupting a listener for, and the sentence each gets.
 *
 * Exactly the three phases in which the acting player is not necessarily the player whose turn
 * it is (the engine's `INTERRUPT_PHASES`) — the game's most confusing moment, and the one place
 * `assertive` is the right politeness (G-54). A phase absent from this table is announced by
 * whatever else the transition produced, not twice.
 *
 * The keys carry no params: `PhaseChanged` ships only `previous` and `current`, so a sentence
 * naming the debtor or the amount would be inventing data the event does not have.
 */
export const INTERRUPT_PHASE_KEYS: Partial<Readonly<Record<Phase, string>>> = {
  auction: "a11y.phase_auction",
  debt_settlement: "a11y.phase_debt_settlement",
  trade_review: "a11y.phase_trade_review",
};

export function narrate(event: GameEvent, context: NarrationContext): readonly AnnouncementDraft[] {
  switch (event.type) {
    case "turn_started":
      return [assertive("a11y.turn", { name: context.playerName(event.player) })];

    case "dice_rolled":
      return [
        polite("a11y.dice_result", { first: event.first, second: event.second, total: event.total }),
      ];

    case "token_moved": {
      const drafts: AnnouncementDraft[] = [];
      // Passing GO happens *during* the move, so it is said first. The salary itself arrives as
      // its own `CashChanged` and is announced there — this sentence carries no amount because
      // `TokenMoved` carries none.
      if (event.passed_go) {
        drafts.push(polite("a11y.passed_go", { name: context.playerName(event.player) }));
      }
      drafts.push(
        polite("a11y.moved", {
          name: context.playerName(event.player),
          tile: context.tileName(event.to_tile),
        }),
      );
      return drafts;
    }

    case "cash_changed": {
      // The sign selects the verb. That is grammar, not arithmetic: the balance and the delta
      // are both the server's, and nothing here works out what either should have been.
      if (event.delta === 0) {
        return [];
      }
      const key = event.delta > 0 ? "a11y.cash_gained" : "a11y.cash_paid";
      return [
        polite(key, { name: context.playerName(event.player), amount: Math.abs(event.delta) }),
      ];
    }

    case "rent_charged":
      return [
        polite("a11y.rent_charged", {
          payer: context.playerName(event.payer),
          owner: context.playerName(event.owner),
          amount: event.amount,
        }),
      ];

    case "phase_changed": {
      const key = INTERRUPT_PHASE_KEYS[event.current];
      return key === undefined ? [] : [assertive(key, {})];
    }

    default:
      // Every other event is rendered visually by the event log (MON-407) and narrated by
      // nothing: an assertive region that reads out all 24 event types is a region nobody can
      // listen to. The remaining sentences arrive with the screens that need them.
      return [];
  }
}

function polite(key: string, params: AnnouncementDraft["params"]): AnnouncementDraft {
  return { politeness: "polite", key, params };
}

function assertive(key: string, params: AnnouncementDraft["params"]): AnnouncementDraft {
  return { politeness: "assertive", key, params };
}
