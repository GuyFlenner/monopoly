/**
 * The game screen: eleven components, one composition, and not one rule between them.
 *
 * ## What this file is allowed to decide
 *
 * Where a component goes, and nothing else. Every fact on screen arrives through `useGame()` and
 * is handed on unexamined:
 *
 * - `legalCommands` reaches `<ActionBar>` **verbatim** — no filter, no sort, no slice, no
 *   `disabled`. That is the ADR-005 line, and it is the one thing in this file that would be
 *   worth reverting a release over. A button exists because the engine offered the command.
 * - Which panel is up comes from `state.interrupts` and nothing else. The top of the interrupt
 *   stack is the live frame (`state.py`'s `top_interrupt`), so an auction frame shows the auction
 *   and a trade frame shows the trade panel. This file never infers "an auction is probably
 *   happening" from a phase name it recognises, and it never keeps its own idea of what the table
 *   is doing — a second opinion about the phase is a rule, and it would be the one that is wrong.
 * - Every figure — cash, the turn number, the dice total — is read from the projection. There is
 *   no arithmetic in this file at all.
 *
 * ## Public holdings, on anybody's turn
 *
 * Spec §5.2: holdings are public information under the universal rules. So the dossier is not the
 * current player's card with a switch on it — it is a seat picker over `state.players` and a
 * `<PlayerDossier>` for whichever seat is chosen, on anybody's turn, with no per-seat gating. The
 * default is the acting seat because that is the one being asked to decide something.
 *
 * ## One live region, and it is not here
 *
 * There is no `aria-live`, no `role="status"` and no `role="alert"` below. `<Announcer>` at the
 * root owns both regions (GAP D1/G-54), and `useEventNarration()` is called here — once, from the
 * thing that renders a live game — to feed it. A failure is reported by moving focus to the
 * message instead, which is the WCAG 3.3.1 answer and says the reason once rather than twice.
 *
 * ## A dropped socket is not a broken game
 *
 * Losing the WebSocket loses the *push*, not the state: the view is still in the cache and a
 * command still round-trips over HTTP. So a reconnect is a quiet line of text above the board and
 * the board stays exactly where it was. Blanking the screen would be reporting a worse failure
 * than the one that happened.
 *
 * *Visual direction*: the felt table, with the board as the centrepiece and a column of painted
 * cards beside it — the moves, the wallet, the ledger. On a phone the column falls below the
 * board rather than shrinking beside it, because a 320 px board is already the whole width.
 */

import { useCallback, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useEventNarration } from "@/a11y";
import type { ApiError, Command, PlayerView } from "@/api";
import {
  Board,
  describeTile,
  DiceTray,
  seatOf,
  SkipAnimationsToggle,
  Token,
  TOKEN_PX,
  type Translate,
} from "@/board";
import { LocaleSwitch } from "@/i18n/LocaleSwitch";
import { ActionBar, ACTIONS_REGION_ID } from "@/panels/ActionBar";
import { AuctionPanel } from "@/panels/AuctionPanel";
import { EventLog } from "@/panels/EventLog";
import { PlayerDossier } from "@/panels/PlayerDossier";
import { TradeBuilder } from "@/panels/TradeBuilder";

import { useUiStore } from "./uiStore";
import { useGame } from "./useGame";

export interface GameScreenProps {
  /** Leave this game and go back to the setup screen. */
  readonly onLeave: () => void;
}

/**
 * Turn an {@link ApiError} into a sentence.
 *
 * The server answers `{reason_key, params}` and never prose (ADR-008 §4), so rendering a failure
 * is a catalogue lookup. The `exists` guard is not defensive noise: `missingKeyHandler` throws
 * under dev and test by design, so an unguarded `t()` on a key a newer server invented would
 * replace the error message with a blank screen. The fallback is chosen by HTTP class — a 4xx is
 * a refusal, anything else did not reach the rules at all — which is transport, not a rule.
 */
export function useReasonText(): (error: ApiError) => string {
  const { t, i18n } = useTranslation();
  return useCallback(
    (error: ApiError) => {
      if (i18n.exists(error.reasonKey)) {
        return t(error.reasonKey, error.params);
      }
      const fallback =
        error.status >= 400 && error.status < 500 ? "error.illegal_move" : "error.network";
      return t(fallback, error.params);
    },
    [t, i18n],
  );
}

/**
 * A failure, as a focus target rather than an announcement.
 *
 * `tabIndex={-1}` plus focus on mount: the same shape `SetupScreen` uses, for the same reason —
 * the one live region belongs to `<Announcer>`, and a second one here would say the reason twice.
 */
export function FailureNote({
  heading,
  body,
  action,
}: {
  readonly heading: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      tabIndex={-1}
      ref={(node) => {
        node?.focus();
      }}
      className="flex flex-col items-start gap-2 rounded-xl border-s-4 border-[oklch(58%_0.19_25)] bg-[oklch(58%_0.19_25)]/10 p-3 text-start"
    >
      <strong className="text-sm">{heading}</strong>
      <p className="text-sm">{body}</p>
      {action}
    </div>
  );
}

/** The header both the loading gate and the game itself carry, so leaving is always possible. */
function Chrome({
  onLeave,
  children,
}: {
  readonly onLeave: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-2 text-start sm:p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("app.title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* The dice tray's copy of this switch is off; the setting lives in the chrome so it is
              reachable without hunting for the board's interior. The store behind it is
              module-level, so the two cannot disagree. */}
          <SkipAnimationsToggle />
          {/* Mid-game language change, which M5 requires to leave game state untouched. It does,
              structurally rather than by care: this control writes to i18next and the document
              element, and the game reaches this package as a projection cached by TanStack Query
              that nothing here invalidates. */}
          <LocaleSwitch />
          <button
            type="button"
            onClick={onLeave}
            className="target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {t("app.new_game")}
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

/** Whose turn it is, in the board's interior well. Both figures are read, never worked out. */
function TurnSummary({
  players,
  currentId,
  turnNumber,
}: {
  readonly players: readonly PlayerView[];
  readonly currentId: number;
  readonly turnNumber: number;
}): React.JSX.Element {
  const { t } = useTranslation();
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
        <span dir="ltr" className="font-bold tabular-nums">
          {current?.cash ?? 0}
        </span>
      </p>
    </div>
  );
}

export function GameScreen({ onLeave }: GameScreenProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { state, board, legalCommands, send, validate, events, status } = useGame();
  // The wire from the event stream to the one `<Announcer>`. Called here because this is the
  // component that renders a live game, and calling it twice would say every roll twice.
  useEventNarration();

  const reasonText = useReasonText();
  const playersHeadingId = useId();

  const selectedPlayer = useUiStore((ui) => ui.selectedPlayer);
  const selectPlayer = useUiStore((ui) => ui.selectPlayer);
  const selectedTile = useUiStore((ui) => ui.selectedTile);
  const selectTile = useUiStore((ui) => ui.selectTile);
  const panel = useUiStore((ui) => ui.panel);
  const openPanel = useUiStore((ui) => ui.openPanel);
  const closePanel = useUiStore((ui) => ui.closePanel);

  /** A trade offer this seat has read and put down. UI-local: the frame is still live. */
  const [dismissedTrade, setDismissedTrade] = useState<string | null>(null);

  /**
   * Post a command.
   *
   * The rejection is caught rather than left floating: the mutation already records it and
   * `status.error` is where it is rendered, so a second report would be the same failure twice.
   */
  const dispatch = useCallback(
    (command: Command) => {
      void send(command).catch(() => undefined);
    },
    [send],
  );

  const translate = useCallback<Translate>((key, params) => t(key, params ?? {}), [t]);

  const tileName = useCallback(
    (index: number) => {
      const nameKey = board?.tiles[index]?.name_key;
      if (nameKey === undefined || board === undefined) {
        return t("label.unknown_square");
      }
      // Square names live in a namespace per board, and `missingKeyHandler` throws under dev and
      // test — the same guard the log, the bar and the dossier all carry (GAP G-46).
      const scoped = `board-${board.id}:${nameKey}`;
      return i18n.exists(scoped) ? t(scoped) : t("label.unknown_square");
    },
    [board, t, i18n],
  );

  /** The live frame is the top of the stack — the engine's own `top_interrupt`. */
  const live = state?.interrupts.at(-1);
  const auctionFrame = live?.kind === "auction" ? live : undefined;
  const tradeFrame = live?.kind === "trade" ? live : undefined;

  const tradeKey = tradeFrame === undefined ? null : JSON.stringify(tradeFrame.offer);
  const reviewingTrade = tradeKey !== null && tradeKey !== dismissedTrade;
  const draftingTrade = panel === "trade";

  const shownPlayer =
    state?.players.find((player) => player.id === (selectedPlayer ?? state.current_player_id)) ??
    state?.players[0];

  const squareNote = useMemo(() => {
    if (selectedTile === null || board === undefined || state === undefined) {
      return null;
    }
    const tile = board.tiles[selectedTile];
    if (tile === undefined) {
      return null;
    }
    const property = state.properties[selectedTile];
    const owner = property?.owner ?? null;
    return describeTile(
      {
        name: tileName(selectedTile),
        kind: tile.kind,
        ownerName:
          owner === null
            ? undefined
            : (state.players.find((player) => player.id === owner)?.name ?? String(owner)),
        houses: property?.houses ?? 0,
        mortgaged: property?.mortgaged ?? false,
        occupantNames: state.players
          .filter((player) => !player.bankrupt && player.position === selectedTile)
          .map((player) => player.name),
      },
      translate,
    );
  }, [selectedTile, board, state, tileName, translate]);

  const connectionKey =
    status.connection.state === "reconnecting"
      ? "status.reconnecting"
      : status.connection.state === "closed"
        ? "status.offline"
        : null;

  // Nothing to draw yet: either the first view is still in flight, or it failed. Both keep the
  // chrome, so "New game" is reachable from a game id that no longer resolves.
  if (state === undefined || board === undefined || shownPlayer === undefined) {
    return (
      <Chrome onLeave={onLeave}>
        {status.error === undefined ? (
          <p className="text-sm opacity-80">{t("label.loading")}</p>
        ) : (
          <FailureNote heading={t("error.title")} body={reasonText(status.error)} />
        )}
      </Chrome>
    );
  }

  return (
    <Chrome onLeave={onLeave}>
      {connectionKey !== null && (
        <p data-testid="connection-note" className="text-sm opacity-80">
          {t(connectionKey)}
        </p>
      )}

      {status.error !== undefined && (
        <FailureNote heading={t("error.title")} body={reasonText(status.error)} />
      )}

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <main className="flex min-w-0 flex-col gap-3">
          <Board
            board={board}
            state={state}
            actionsRegionId={ACTIONS_REGION_ID}
            onOpenTile={selectTile}
          >
            {/* The 9 x 9 interior well, which `Board` takes `children` for. */}
            <div className="flex flex-col items-center gap-2">
              <TurnSummary
                players={state.players}
                currentId={state.current_player_id}
                turnNumber={state.turn_number}
              />
              {/* The switch lives in the chrome, so the tray does not draw a second one. */}
              <DiceTray dice={state.dice} withSkipToggle={false} />
            </div>
          </Board>

          {squareNote !== null && (
            <p className="bg-tile text-ink border-hairline rounded-xl border p-3 text-sm">
              <span className="me-2 text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
                {t("label.selected_square")}
              </span>
              {squareNote}
            </p>
          )}
        </main>

        <aside className="flex min-w-0 flex-col gap-4">
          {/*
            `legalCommands` verbatim, and `send` as the sink. The two together are the whole of
            ADR-005 on this side of the wire.
          */}
          <ActionBar
            id={ACTIONS_REGION_ID}
            commands={legalCommands}
            onCommand={dispatch}
            board={board}
            jailFine={state.ruleset.jail_fine}
          />

          {/*
            Offering a trade is not an enumerable command — `legality.py` never enumerates
            `ProposeTrade`, because the drafts are unbounded — so the builder needs an affordance
            of its own. It is *not* gated on `ruleset.trading_enabled`: whether a trade may be
            proposed is the engine's answer, and the validator gives it inside the panel.
          */}
          <button
            type="button"
            onClick={() => {
              openPanel("trade");
            }}
            className="target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {t("action.propose_trade")}
          </button>

          <section aria-labelledby={playersHeadingId} className="flex flex-col gap-2">
            <h2
              id={playersHeadingId}
              className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70"
            >
              {t("dossier.all_players")}
            </h2>
            {/*
              Every seat, always — including on someone else's turn (spec §5.2, MON-406). No
              per-seat gate, because holdings are public under the universal rules.
            */}
            <div className="flex flex-wrap gap-2">
              {state.players.map((player) => {
                const seat = seatOf(state.players, player.id);
                return (
                  <button
                    key={player.id}
                    type="button"
                    aria-pressed={player.id === shownPlayer.id}
                    onClick={() => {
                      selectPlayer(player.id);
                    }}
                    className="target bg-tile text-ink border-hairline flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold aria-pressed:font-bold"
                  >
                    {seat !== undefined && <Token seat={seat} size={TOKEN_PX.inline} />}
                    <span>{player.name}</span>
                  </button>
                );
              })}
            </div>
            <PlayerDossier
              player={shownPlayer}
              players={state.players}
              board={board}
              properties={state.properties}
              isCurrent={shownPlayer.id === state.current_player_id}
              onSelectSquare={selectTile}
            />
          </section>

          <EventLog events={events} players={state.players} board={board} />
        </aside>
      </div>

      {/*
        An auction is a phase, so the panel has no `onClose`: `ModalDialog` narrates
        `auction.cannot_leave` on Escape rather than dropping a player onto a board that is not
        taking commands.
      */}
      {auctionFrame !== undefined && (
        <AuctionPanel
          frame={auctionFrame}
          players={state.players}
          board={board}
          legalCommands={legalCommands}
          onSend={dispatch}
        />
      )}

      {/*
        The trade panel, in either of the two situations that call for it: a draft this seat opened,
        or an offer waiting for an answer.

        The review case used to be a known mismatch — the panel had no review mode, so it drew two
        empty trays and the answers were only reachable as chits on the bar *behind* the modal. MON-422
        closed that: passing the live `frame` puts the panel in review mode, where it renders the
        pending offer read-only with accept and decline in the footer. `frame` is `undefined` for a
        draft, which is what selects the builder.

        `onClose` stays. In review it is the way out for a player who wants to look at the board before
        answering — the offer is still on the interrupt stack, so the panel comes back.
      */}
      {(reviewingTrade || draftingTrade) && (
        <TradeBuilder
          frame={reviewingTrade ? tradeFrame : undefined}
          proposer={tradeFrame?.offer.proposer ?? state.current_player_id}
          players={state.players}
          board={board}
          simplifiedTrades={state.ruleset.simplified_trades}
          validate={validate}
          /*
            Sending closes the panel, because in both modes the panel's job is finished: a draft that
            has been proposed is no longer a draft, and an answered review has nothing left to show.

            Without this, `draftingTrade` (`panel === "trade"`) stays true after a `propose_trade`, so
            the moment the review interrupt resolves the *builder* reopens over the board with two
            empty trays. Answering a trade appeared to do nothing. A pre-existing wart the MON-422 e2e
            spec surfaced — before it, the same reopen happened after answering on the action bar and
            nothing was watching the whole round trip.

            Proposing still shows the review: `reviewingTrade` comes from the interrupt stack, not from
            the panel state, so closing the panel here cannot hide an offer that is genuinely pending.
          */
          onSend={(command) => {
            dispatch(command);
            closePanel();
          }}
          onClose={() => {
            setDismissedTrade(tradeKey);
            closePanel();
          }}
          renderDossier={(playerId) => {
            const player = state.players.find((candidate) => candidate.id === playerId);
            return player === undefined ? null : (
              <PlayerDossier
                player={player}
                players={state.players}
                board={board}
                properties={state.properties}
                isCurrent={player.id === state.current_player_id}
              />
            );
          }}
        />
      )}
    </Chrome>
  );
}
