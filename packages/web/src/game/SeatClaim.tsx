/**
 * Taking a seat in a game you followed a link into (ADR-012, MON-906).
 *
 * ## Where this appears, and why there is no join screen
 *
 * There is no lobby, because the *link is the invitation* (MON-727/728): `?game=<id>` puts a second
 * browser straight onto the board. What was missing was any notion of **which seat is yours** — and
 * the audit measured the consequence, which was that two windows on one link could each act for
 * either player. So the affordance belongs exactly where the join flow already lands somebody: at
 * the top of the game screen, above the board they are already looking at.
 *
 * It is a sibling of `ConnectionNote` and sits beside it for the same reason that one does: both are
 * a sentence about *this connection* rather than about the game, and both render `null` when there
 * is nothing to say — which keeps the caller a single element instead of a conditional.
 *
 * ## When it shows itself
 *
 * Only when this browser holds no credential for this game **and** the server has offered at least
 * one free seat. Both halves matter:
 *
 * * The host holds a secret from the moment they created the game, so they never see this.
 * * A guest who has claimed a seat holds one too, so it disappears the moment they take a chair.
 * * A watcher at a table where every seat is taken is genuinely a spectator, and a picker with
 *   nothing in it would be an affordance that cannot work — `SetupScreen.onLoad`'s rule, applied
 *   here: a control that cannot work should not be on the screen explaining why.
 *
 * ## What it is not allowed to decide
 *
 * Which seats exist and which are free is `GameView.claims` — the server's projection, rendered
 * unexamined. This file does not filter bots (the projection carries human seats only), does not
 * work out whether a seat is "really" free, and does not decide what happens after a claim: the
 * response is a `GameView` and the cache is invalidated, exactly as every other view arrives.
 *
 * *Visual direction*: a quiet card above the board, not a modal. Somebody who followed a link to
 * watch has not asked to be interrupted, and somebody who came to play will find a row of names
 * with their own on it. The buttons are ordinary `.target` chits, so they inherit the 44 px floor
 * and the kids comfort scale from the chrome.
 */

import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { isApiError, type ApiError, type GameView, type PlayerView, type SeatClaimView } from "@/api";
import { Token } from "@/board";
import { seatOf } from "@/board";
import { ErrorState } from "@/panels/States";

export interface SeatClaimProps {
  /** The server's seat projection. Human seats only; never the secrets. */
  readonly claims: readonly SeatClaimView[];
  readonly players: readonly PlayerView[];
  /** Whether this browser already speaks for a seat — the host, or a guest who has claimed one. */
  readonly seated: boolean;
  /** Take a seat. Resolves with the view filtered to it; rejects with a keyed {@link ApiError}. */
  readonly onClaim: (player: number) => Promise<GameView>;
}

export function SeatClaim({
  claims,
  players,
  seated,
  onClaim,
}: SeatClaimProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const headingId = useId();
  const [failure, setFailure] = useState<ApiError | undefined>(undefined);
  /*
    Which seat is being claimed, so its own button reports the wait rather than the whole row going
    quiet. `null` is "none in flight". A single boolean would disable every button while one was
    pending, which is the same information rendered less usefully.
  */
  const [claiming, setClaiming] = useState<number | null>(null);

  const claim = useCallback(
    (player: number) => {
      setClaiming(player);
      setFailure(undefined);
      void onClaim(player)
        .catch((cause: unknown) => {
          // The keyed refusal, rendered rather than swallowed: `error.seat_taken` is the answer to
          // two people pressing the same chair at once, and it is a sentence a player can act on.
          setFailure(isApiError(cause) ? cause : undefined);
        })
        .finally(() => {
          setClaiming(null);
        });
    },
    [onClaim],
  );

  const free = claims.filter((claim) => !claim.claimed);
  if (seated || free.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="seat-claim"
      className="bg-tile text-ink border-hairline flex flex-col gap-2 rounded-xl border p-3 text-start"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        {t("seat.claim_prompt")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {free.map((seat) => {
          const player = players.find((candidate) => candidate.id === seat.player);
          const pawn = seatOf(players, seat.player);
          return (
            <button
              key={seat.player}
              type="button"
              data-testid={`claim-seat-${String(seat.player)}`}
              disabled={claiming !== null}
              onClick={() => {
                claim(seat.player);
              }}
              className="target bg-felt text-ink border-hairline flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-60"
            >
              {pawn !== undefined && <Token seat={pawn} size={20} />}
              {/*
                The seat's own name, which a parent typed at the setup screen — so the guest picks
                "Dana" rather than "seat 1". The fallback is the id rather than an invented name, the
                same rule `GameScreen.playerName` follows: a seat this screen has not been told about
                shows up as a number to investigate instead of as plausible text.
              */}
              <span>{player?.name ?? String(seat.player)}</span>
            </button>
          );
        })}
      </div>
      {/*
        The refusal, in the player's own language. No retry button: the retry for "somebody took that
        seat" is pressing a different seat, and the row above is that.
      */}
      {failure !== undefined && <ErrorState error={failure} testId="seat-claim-error" />}
    </section>
  );
}
