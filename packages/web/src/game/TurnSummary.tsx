/**
 * The board's interior well: whose turn it is, and what that seat is holding.
 *
 * Moved out of `GameScreen.tsx` in MON-747 unchanged. It takes `t` and `money` as props rather than
 * reading the hooks itself, and that is deliberate rather than left over: the screen's translate is
 * `useCopy(kids)`, which prefers the simpler `kids.*` wording, so a component that called
 * `useTranslation` here would quietly say something else in a kids game than the column beside it.
 */

import { Pulse } from "@/animation";
import type { PlayerView } from "@/api";
import { seatOf, Token, TOKEN_PX, type Translate } from "@/board";

/** Whose turn it is, in the board's interior well. Both figures are read, never worked out. */
export function TurnSummary({
  players,
  currentId,
  turnNumber,
  cashPulse,
  t,
  money,
}: {
  readonly players: readonly PlayerView[];
  readonly currentId: number;
  readonly turnNumber: number;
  /** The animation queue's cash beat for the acting seat (MON-701). Presentation only. */
  readonly cashPulse?: number | undefined;
  /** The screen's translate, so the well's wording matches the column beside it. */
  readonly t: Translate;
  /** The screen's money formatter, passed for the same reason `t` is (MON-720). */
  readonly money: (amount: number) => string;
}): React.JSX.Element {
  const current = players.find((player) => player.id === currentId);
  const seat = current === undefined ? undefined : seatOf(players, current.id);

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <p className="text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-80">
        {t("label.turn", { number: turnNumber })}
      </p>
      <p className="flex items-center gap-2 text-sm font-bold">
        {seat !== undefined && <Token seat={seat} size={TOKEN_PX.heading} isCurrent />}
        <span>{current?.name ?? String(currentId)}</span>
      </p>
      <p className="flex items-baseline gap-2 text-xs">
        <span className="opacity-80">{t("label.cash")}</span>
        {/* The figure is the projection's; the beat only decides whether it arrives with a swell. The
            symbol is the language's (MON-720) — `dir="ltr"` stays, because `50 ₪` is a left-to-right
            sequence of characters inside a right-to-left page either way. */}
        <Pulse nonce={cashPulse}>
          <span dir="ltr" className="font-bold tabular-nums">
            {money(current?.cash ?? 0)}
          </span>
        </Pulse>
      </p>
    </div>
  );
}
