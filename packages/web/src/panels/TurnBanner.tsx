/**
 * Whose turn it is, big enough to follow without reading (MON-604).
 *
 * ## Why a banner as well as the board's turn summary
 *
 * The interior well already names the acting seat, beside the dice and the cash, at the size a
 * ledger wants. That is the right size for an adult checking a figure and the wrong one for the
 * question a six-year-old asks every thirty seconds — *is it me?* — because the answer is 12 px
 * tall and surrounded by other 12 px things. So this is a band across the top of the board with one
 * piece and one name in it, and nothing else competing.
 *
 * ## Three channels, none of them colour alone
 *
 * The piece is `TOKEN_IDENTITY`'s shape **and** colour **and** rider icon (`theme/tokens.ts`), the
 * same silhouette the board is moving around the ring, so "the triangle is playing" is checkable
 * against the board without reading either. The name is beside it in text. A pre-reader matches the
 * shape; a reader reads the name; a colourblind adult uses either.
 *
 * The piece is drawn larger in a kids game, because the shape is the channel a pre-reader is
 * actually using — and only the piece is: the 44 px floor belongs to controls, and this is not one.
 *
 * ## It does not speak, and it is not a live region
 *
 * `useEventNarration` already announces a turn change assertively through the single `<Announcer>`
 * (MON-411): that is the moment the acting player changes, which is the one thing the assertive
 * region is for. An `aria-live` here would say it a second time (GAP D1/G-54). This is a heading and
 * a name — reachable at any moment, announced by nobody.
 *
 * Every value is read: `players`, `current_player_id` and `turn_number` come off the projection and
 * nothing is worked out from them.
 */

import type { PlayerView } from "@/api";
import { seatOf, Token, TOKEN_PX } from "@/board";
import type { Copy } from "@/i18n/copy";

/** The piece's edge in a kids game. Deliberately larger than every size on `TOKEN_PX`. */
export const KIDS_TOKEN_PX = 44;

export interface TurnBannerProps {
  /** `state.players`, in the projection's order — which is what `seatOf` maps to an identity. */
  readonly players: readonly PlayerView[];
  /** `state.current_player_id`. */
  readonly currentId: number;
  /** `state.turn_number`. */
  readonly turnNumber: number;
  /** Draw the piece at {@link KIDS_TOKEN_PX}. `presentationFor(state.ruleset).kids`. */
  readonly kids: boolean;
  /** The screen's translate, so the wording matches the rest of it. */
  readonly t: Copy;
}

export function TurnBanner({
  players,
  currentId,
  turnNumber,
  kids,
  t,
}: TurnBannerProps): React.JSX.Element {
  const current = players.find((player) => player.id === currentId);
  const seat = current === undefined ? undefined : seatOf(players, current.id);
  // A seat with no identity is a projection this component cannot draw a piece for; the name still
  // renders, because "whose turn is it" must not be answered with nothing.
  const name = current?.name ?? String(currentId);

  return (
    <div
      data-testid="turn-banner"
      data-kids={kids}
      className="bg-tile text-ink border-hairline flex flex-wrap items-center gap-3 rounded-2xl border p-3"
    >
      {seat !== undefined && (
        <Token seat={seat} size={kids ? KIDS_TOKEN_PX : TOKEN_PX.heading} isCurrent />
      )}
      <p
        data-testid="turn-banner-name"
        className={kids ? "text-2xl font-bold" : "text-lg font-bold"}
      >
        {t("turn.banner", { name })}
      </p>
      {/* The turn count, kept small: it is a fact about the game, not about who is holding the dice. */}
      <p
        dir="ltr"
        className="ms-auto text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-70 tabular-nums"
      >
        {t("label.turn", { number: turnNumber })}
      </p>
    </div>
  );
}
