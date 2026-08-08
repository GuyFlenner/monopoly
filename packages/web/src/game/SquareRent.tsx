/**
 * The rent readout under an opened square.
 *
 * Moved out of `GameScreen.tsx` in MON-747 unchanged, docstring and all — the reasoning below is
 * about this component and travels with it.
 */

import type { RentQuote } from "@/api";
import type { GroupNameScope } from "@/i18n/groupNames";
import { noteLines } from "@/panels/EventLogLines";
import { RentExplanation } from "@/panels/HintPanel";

/**
 * What the selected square would charge, and why (MON-420).
 *
 * Every figure is `RentQuote`'s, and the explanation is the engine's own `rent.note.*` keys
 * rendered through the same resolver the event log uses — so the sentence a player reads *before*
 * landing is assembled exactly like the one they read in the log afterwards. Two resolvers is how
 * the board and the log would end up explaining one figure differently.
 *
 * `amount` is nullable and the nullability is the point: a utility's rent is a multiple of a throw
 * that has not happened, so the engine sends no amount and `rent.note.utility_quote` says
 * "× whatever the dice show". Printing the last roll's total, or an average, would be a number
 * nothing stands behind.
 *
 * Nothing here decides whether rent is owed. A square that charges nothing quotes `null`, which is
 * why the caller renders no panel at all rather than a zero.
 */
export function SquareRent({
  quote,
  scope,
  kids,
  money,
}: {
  readonly quote: RentQuote;
  /**
   * The screen's translate plus the board a group's name may come from.
   *
   * A scope rather than a bare `t` because `rent.note.full_group_doubled` interpolates a group, and
   * on the Israeli board a group is a city — "the whole Tel Aviv set", not "the whole dark blue
   * set". `noteLines` routes every `*_key` param through `groupLabel`, and this is what it needs to
   * do it (`i18n/groupNames.ts`).
   */
  readonly scope: GroupNameScope;
  /** Unfold the "why this much?" breakdown by default. `presentation.kids` (MON-605). */
  readonly kids: boolean;
  /**
   * The screen's money formatter, passed for the same reason `TurnSummary` takes one (MON-720).
   *
   * This figure is the projection's own integer and reaches the player without passing through a
   * catalogue sentence, so nothing else on the way can tell it which currency it is — which is how
   * it came to sit bare beside "Lowest you can bid: $10" (MON-744).
   */
  readonly money: (amount: number) => string;
}): React.JSX.Element {
  const t = scope.translate;
  return (
    <span data-testid="square-rent" className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
          {t("label.rent")}
        </span>
        {quote.amount !== null && quote.amount !== undefined && (
          <span data-testid="square-rent-amount" dir="ltr" className="font-bold tabular-nums">
            {/* `dir="ltr"` and `tabular-nums` both survive the symbol: `50 ₪` is a left-to-right
                sequence inside a right-to-left page either way, and the tabular figures are what
                stop the number jumping when a quote changes — the glyph is one more character in
                front of them, not a different kind of text. */}
            {money(quote.amount)}
          </span>
        )}
        {noteLines(quote.note_keys, quote.note_params, scope).map((note) => (
          <span key={note.key} className="text-xs opacity-75">
            {t(note.key, note.params)}
          </span>
        ))}
      </span>
      {/*
        MON-605's "why this number" affordance, on top of MON-420's sentences rather than instead of
        them: the engine's own explanation stays on screen, and the *figures* it was built from fold
        away behind a disclosure that Kids Mode opens. Nothing in there is multiplied — see
        `RentExplanation`.
      */}
      <RentExplanation quote={quote} t={t} open={kids} />
    </span>
  );
}
