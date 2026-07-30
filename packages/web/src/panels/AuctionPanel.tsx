/**
 * The auction, as a child can read it.
 *
 * Four things are worth understanding before changing anything here.
 *
 * 1. **Every fact on screen is projected, not derived.** Bidding order is `frame.eligible`, who is
 *    still in is `frame.active`, who has dropped out is `frame.withdrawn`, whose turn it is is
 *    `frame.turn`, and the standing bid is `frame.high_bid`/`frame.high_bidder`. In particular
 *    "who withdrew" is **never** computed as `eligible − active`: the two are shipped separately
 *    because they answer different questions, and a client that subtracts them has guessed at a
 *    rule. `AuctionPanel.test.tsx` feeds a frame where the subtraction gives the wrong answer and
 *    asserts the projected array wins.
 *
 * 2. **The bid ceiling is `frame.max_bid`, and this file cannot work one out.** A bidder's cash is
 *    on the wire, so it would be one subtraction to invent a limit — and that subtraction is the
 *    rule "you may not bid more than you hold" restated in TypeScript, which is the exact defect
 *    G-7b added `min_bid`/`max_bid` to prevent. Cash appears below for one purpose only: deciding
 *    how *alarmed* to look. It never bounds the control.
 *
 * 3. **Bidding your whole cash is legal, so the engine offers it — and a six-year-old must not do
 *    it by accident** (GAP C4). The primary controls are three chunky increments, so the common
 *    move is a tap rather than a typed number; past half your cash the panel warns; at nine tenths
 *    it takes a confirm step. None of that forbids anything the engine allows.
 *
 * 4. **Withdrawal is terminal**, so it goes through the same confirm step, and this file asks
 *    `requiresConfirmation` rather than keeping its own list of which commands are final.
 *
 * *Visual direction — the bidder rail.* The one thing this panel is remembered by: a strip of
 * darker felt carrying every bidder as their own seat piece, in the engine's order. The player to
 * act is raised off the felt with a paddle beside them, whoever holds the bid wears a ribbon with
 * the figure on it, and anyone who has dropped out is struck through and greyed with a cross. Who
 * is in, who is out, who is winning and who is up — four questions answered by shape, position
 * and mark, with the text as a second channel rather than the only one. Everything else on the
 * panel is deliberately plain so the rail is the thing the eye goes to.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView, Command, InterruptFrameView, PlayerView } from "@/api";
import { seatOf, Token, TOKEN_PX } from "@/board";
import { Icon, requiresConfirmation } from "@/theme";

import { ModalDialog } from "./ModalDialog";
import { EmptyState } from "./States";

/** The auction frame, narrowed out of the interrupt union rather than restated. */
export type AuctionFrameView = Extract<InterruptFrameView, { kind: "auction" }>;

/**
 * The increments, smallest first.
 *
 * Three, not five: a row of five buttons at 44 px each does not fit 320 px, and the numeric field
 * below covers everything the three cannot reach. They are absolute rather than percentages of
 * the standing bid, because "add ten" is a thing a child can predict and "add 10%" is not.
 */
export const BID_INCREMENTS: readonly number[] = [1, 10, 50];

/** Past this share of the bidder's cash the panel warns. Presentation, not a limit (GAP C4). */
export const WARN_CASH_RATIO = 0.5;

/** At this share of the bidder's cash the bid takes a confirm step. Still not a limit. */
export const CONFIRM_CASH_RATIO = 0.9;

/** What the panel is waiting to be told twice. `null` when nothing is pending. */
type Pending = { readonly kind: "bid"; readonly amount: number } | { readonly kind: "withdraw" };

export interface AuctionPanelProps {
  /** The projected auction. Every fact the panel shows comes from here. */
  readonly frame: AuctionFrameView;
  /** Seat order and names. Also the bidder's cash, used only to size the warning. */
  readonly players: readonly PlayerView[];
  /** The only source of the lot's name. */
  readonly board: BoardView;
  /** The engine's offer, verbatim. A control exists only if the matching command is in here. */
  readonly legalCommands: readonly Command[];
  readonly onSend: (command: Command) => void;
  /**
   * How to leave, when leaving is possible at all. An auction is a phase, so this is normally
   * omitted and Escape narrates `auction.cannot_leave` instead (GAP E1).
   */
  readonly onClose?: (() => void) | undefined;
}

export function AuctionPanel({
  frame,
  players,
  board,
  legalCommands,
  onSend,
  onClose,
}: AuctionPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const bidder = frame.turn ?? null;
  const [amount, setAmount] = useState(frame.min_bid);
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // A new bidder, or a new floor under the bidding, makes the box's contents stale. Resetting to
  // the projected minimum is the only starting value that is never illegal.
  useEffect(() => {
    setAmount(frame.min_bid);
    setPending(null);
  }, [frame.min_bid, frame.turn]);

  // The confirm step is only useful if a keyboard reaches it without hunting.
  useEffect(() => {
    if (pending !== null) {
      confirmRef.current?.focus();
    }
  }, [pending]);

  const offers = useCallback(
    (kind: Command["kind"]) => legalCommands.some((command) => command.kind === kind),
    [legalCommands],
  );

  const playerName = useCallback(
    (id: number) => players.find((player) => player.id === id)?.name ?? String(id),
    [players],
  );

  const lotName =
    frame.lot.kind === "tile"
      ? (() => {
          const nameKey = board.tiles[frame.lot.tile]?.name_key;
          // Square names live in a namespace per board, so board choice and language stay
          // independent. Resolving them against `common` would miss all forty.
          return nameKey === undefined
            ? String(frame.lot.tile)
            : t(nameKey, { ns: `board-${board.id}` });
        })()
      : t(`building.${frame.lot.building}`);

  const bidderCash = bidder === null ? 0 : (players.find((p) => p.id === bidder)?.cash ?? 0);
  // Share of the bidder's cash this bid would spend. Drives a colour and a confirm step, and
  // nothing else — see the module docstring, point 2.
  const cashShare = bidderCash > 0 ? amount / bidderCash : 0;
  const overWarn = cashShare > WARN_CASH_RATIO;
  const needsBidConfirm = cashShare >= CONFIRM_CASH_RATIO;

  const ceiling = frame.max_bid ?? null;
  const belowFloor = amount < frame.min_bid;
  const aboveCeiling = ceiling !== null && amount > ceiling;
  const canBid = bidder !== null && offers("place_bid") && !belowFloor && !aboveCeiling;
  const canWithdraw = bidder !== null && offers("withdraw_from_auction");

  const step = useCallback(
    (by: number) => {
      setAmount((current) => {
        const raised = current + by;
        // Clamping to a *projected* ceiling is honouring the engine's answer, not computing one.
        return ceiling !== null && raised > ceiling ? ceiling : raised;
      });
      setPending(null);
    },
    [ceiling],
  );

  const submitBid = useCallback(
    (value: number) => {
      if (bidder === null) {
        return;
      }
      onSend({ kind: "place_bid", player: bidder, amount: value });
      setPending(null);
    },
    [bidder, onSend],
  );

  const submitWithdraw = useCallback(() => {
    if (bidder === null) {
      return;
    }
    onSend({ kind: "withdraw_from_auction", player: bidder });
    setPending(null);
  }, [bidder, onSend]);

  const askToBid = useCallback(() => {
    if (needsBidConfirm) {
      setPending({ kind: "bid", amount });
    } else {
      submitBid(amount);
    }
  }, [amount, needsBidConfirm, submitBid]);

  return (
    <ModalDialog
      title={t("auction.title")}
      onClose={onClose}
      cannotCloseKey="auction.cannot_leave"
      headline={
        <span>
          {t("auction.lot", { lot: lotName })} · {t(`auction_reason.${frame.reason}`)}
          {frame.queue.length > 0 &&
            ` · ${t("auction.queue_remaining", { lots: frame.queue.length })}`}
        </span>
      }
      footer={
        pending === null ? (
          <>
            {canWithdraw && (
              <button
                type="button"
                onClick={() => {
                  // Terminal, so it is never sent on one press. The predicate is the theme's, so
                  // this panel cannot drift from the ActionBar about what is final.
                  if (requiresConfirmation("withdraw_from_auction")) {
                    setPending({ kind: "withdraw" });
                  } else {
                    submitWithdraw();
                  }
                }}
                className="target flex items-center gap-2 rounded-2xl border-2 border-hairline px-4 font-semibold"
              >
                <Icon name="paddle" size={20} />
                {t("action.withdraw_from_auction")}
              </button>
            )}
            <button
              type="button"
              disabled={!canBid}
              onClick={askToBid}
              className="target flex items-center gap-2 rounded-2xl border-2 border-hairline bg-ink px-5 text-lg font-bold text-tile disabled:opacity-40"
            >
              <Icon name="paddle" size={22} />
              {t("action.place_bid", { amount })}
            </button>
          </>
        ) : (
          <ConfirmStrip
            ref={confirmRef}
            question={
              pending.kind === "withdraw"
                ? t("auction.confirm_withdraw")
                : t("auction.confirm_whole_cash", { amount: pending.amount })
            }
            confirmLabel={
              pending.kind === "withdraw"
                ? t("action.withdraw_from_auction")
                : t("action.place_bid", { amount: pending.amount })
            }
            onConfirm={() => {
              if (pending.kind === "withdraw") {
                submitWithdraw();
              } else {
                submitBid(pending.amount);
              }
            }}
            onCancel={() => {
              setPending(null);
            }}
          />
        )
      }
    >
      <BidderRail frame={frame} players={players} playerName={playerName} />

      <section className="mt-5" aria-labelledby="auction-bid-heading">
        <h3 id="auction-bid-heading" className="text-lg font-bold">
          {bidder === null
            ? t("auction.nobody_to_bid")
            : t("auction.your_turn_to_bid", { name: playerName(bidder) })}
        </h3>

        <p className="mt-1 text-sm opacity-80">
          {t("auction.floor", { amount: frame.min_bid })}
          {ceiling !== null && ` · ${t("auction.ceiling", { amount: ceiling })}`}
        </p>

        <p className="mt-3 text-5xl font-bold tabular-nums" dir="ltr">
          {amount}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {BID_INCREMENTS.map((by) => (
            <button
              key={by}
              type="button"
              disabled={bidder === null || (ceiling !== null && amount >= ceiling)}
              onClick={() => {
                step(by);
              }}
              className="target flex items-center gap-1 rounded-2xl border-2 border-hairline px-4 text-lg font-bold disabled:opacity-40"
            >
              <Icon name="plus" size={16} />
              <span dir="ltr">{by}</span>
            </button>
          ))}
        </div>

        <label className="mt-4 flex flex-wrap items-center gap-2 text-sm font-medium">
          {t("auction.type_amount")}
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            min={frame.min_bid}
            {...(ceiling !== null ? { max: ceiling } : {})}
            dir="ltr"
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              setAmount(Number.isNaN(next) ? frame.min_bid : next);
              setPending(null);
            }}
            className="target w-32 rounded-2xl border-2 border-hairline bg-tile px-3 text-lg font-bold tabular-nums"
          />
        </label>

        {bidder !== null && bidderCash > 0 && (
          <CashMeter share={cashShare} cash={bidderCash} warn={overWarn} />
        )}

        {aboveCeiling && (
          <p className="mt-2 text-sm font-semibold">
            {t("auction.above_ceiling", { amount: ceiling })}
          </p>
        )}
        {belowFloor && (
          <p className="mt-2 text-sm font-semibold">
            {t("auction.below_floor", { amount: frame.min_bid })}
          </p>
        )}
        {overWarn && !needsBidConfirm && (
          <p className="mt-2 text-sm font-semibold">{t("auction.warn_half_cash")}</p>
        )}
      </section>
    </ModalDialog>
  );
}

/**
 * The rail: every bidder, in the engine's order, with four projected facts drawn on them.
 *
 * Read the three `includes` below carefully — each consults its **own** projected array. The
 * temptation this component exists to resist is one loop over `eligible` that decides "active
 * unless withdrawn", which happens to agree with the engine most of the time and is a rule in the
 * UI regardless.
 */
function BidderRail({
  frame,
  players,
  playerName,
}: {
  readonly frame: AuctionFrameView;
  readonly players: readonly PlayerView[];
  readonly playerName: (id: number) => string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const highBidder = frame.high_bidder ?? null;
  return (
    <section aria-labelledby="auction-bidders-heading">
      <h3 id="auction-bidders-heading" className="text-lg font-bold">
        {t("auction.bidders")}
      </h3>
      {/*
        An auction with nobody eligible to bid is a real frame the engine can produce — every seat
        bankrupt but the one that owns the lot, say — and before MON-708 it rendered as an empty felt
        rectangle under a "Bidders" heading, which reads as a panel that failed to load. It says so
        instead. Not a rule: this is `eligible.length`, not a judgement about who may bid.
      */}
      {frame.eligible.length === 0 && (
        <EmptyState messageKey="auction.no_bidders" className="mt-2" />
      )}
      <ol className="mt-2 flex flex-wrap gap-2 rounded-2xl bg-table p-3 text-on-table">
        {frame.eligible.map((id) => {
          const seat = seatOf(players, id);
          const isWithdrawn = frame.withdrawn.includes(id);
          const isActive = frame.active.includes(id);
          const isTurn = frame.turn === id;
          const isHighBidder = highBidder === id;
          return (
            <li
              key={id}
              data-bidder={id}
              className={`flex min-w-32 grow items-center gap-2 rounded-xl border-2 p-2 ${
                isTurn ? "border-on-table bg-on-table/15" : "border-transparent"
              } ${isWithdrawn ? "opacity-55" : ""}`}
            >
              {seat !== undefined && <Token seat={seat} size={TOKEN_PX.panel} isCurrent={isTurn} />}
              <div className="min-w-0 grow">
                <p className={`truncate font-bold ${isWithdrawn ? "line-through" : ""}`}>
                  {playerName(id)}
                </p>
                <p className="text-xs">
                  {isWithdrawn
                    ? t("auction.dropped_out")
                    : isTurn
                      ? t("auction.bidding_now")
                      : isActive
                        ? t("auction.still_bidding")
                        : ""}
                </p>
              </div>
              {isWithdrawn && <Icon name="cross" size={18} />}
              {isTurn && !isWithdrawn && <Icon name="paddle" size={18} />}
              {isHighBidder && (
                <span
                  className="rounded-full border-2 border-on-table px-2 py-0.5 text-sm font-bold tabular-nums"
                  dir="ltr"
                >
                  {frame.high_bid}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-sm">
        {highBidder === null
          ? t("auction.no_bids_yet", { amount: frame.min_bid })
          : t("auction.standing_bid", { amount: frame.high_bid, name: playerName(highBidder) })}
      </p>
    </section>
  );
}

/**
 * How much of the bidder's cash this bid would spend, as a bar.
 *
 * A number a child cannot read yet, drawn as a length they can. `inlineSize` rather than `width`
 * so the bar fills from the reading edge in both languages.
 */
function CashMeter({
  share,
  cash,
  warn,
}: {
  readonly share: number;
  readonly cash: number;
  readonly warn: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const pct = Math.min(100, Math.max(0, Math.round(share * 100)));
  return (
    <div className="mt-3">
      <div className="h-3 overflow-hidden rounded-full border-2 border-hairline">
        <div
          className={warn ? "h-full bg-ink" : "h-full bg-ink/50"}
          style={{ inlineSize: `${String(pct)}%` }}
        />
      </div>
      <p className="mt-1 text-sm tabular-nums opacity-80">
        {t("auction.share_of_cash", { percent: pct, cash })}
      </p>
    </div>
  );
}

/**
 * Say it twice, with the consequence written out.
 *
 * One strip rather than a nested dialog: a second `role="dialog"` inside the first would mean two
 * focus traps competing over one tab order, and the thing being confirmed is a sentence and two
 * buttons. The cancel is listed first so that the safe answer is the one a keyboard reaches by
 * accident, and focus is placed on the confirm button by the caller so a keyboard user is not
 * hunting for the question they just triggered.
 */
function ConfirmStrip({
  ref,
  question,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  readonly ref: React.Ref<HTMLButtonElement>;
  readonly question: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-wrap items-center gap-3 rounded-2xl border-2 border-hairline p-3">
      <p className="grow text-sm font-semibold">{question}</p>
      <button
        type="button"
        onClick={onCancel}
        className="target rounded-2xl border-2 border-hairline px-4 font-semibold"
      >
        {t("panel.go_back")}
      </button>
      <button
        ref={ref}
        type="button"
        onClick={onConfirm}
        className="target flex items-center gap-2 rounded-2xl border-2 border-hairline bg-ink px-4 font-bold text-tile"
      >
        <Icon name="check" size={18} />
        {confirmLabel}
      </button>
    </div>
  );
}
