/**
 * The replay viewer: step through a recorded game's events (MON-705).
 *
 * ## Its own copy of the log, fetched once
 *
 * The panel asks the server for `GET /games/{id}?since=0` — the whole event log — and holds the
 * answer for as long as it is open. Three reasons it does not read `useGame().events` instead:
 *
 * 1. **That log is bounded.** `EventQueue` keeps the last `DEFAULT_CAPACITY` frames and says so
 *    (`droppedThrough`), so a long game's opening turns are simply not there. A replay missing turn
 *    one is not a replay.
 * 2. **A live game must not move under a reader.** The queue grows while somebody is watching turn
 *    three; a slider whose maximum changes mid-scrub moves the frame the user was looking at.
 * 3. **Watching history must not disturb the live view.** This fetch is its own request against its
 *    own state — it never touches the TanStack cache the game screen renders from, and it never
 *    offers anything to the event queue, so the narration and the sound cues stay silent about a
 *    replay (they narrate the *live* feed, and re-narrating history would be a lie told twice).
 *
 * ## What it can show, and what it therefore does not
 *
 * Everything on screen comes from {@link factsAt} — the facts the events state outright — and from
 * the board data and seat names, which do not change during a game. There is no reconstruction of
 * `GameState`: the UI holds no rules (ADR-005), so it cannot know what a player's net worth was on
 * turn three, and it says nothing about it. A fact no event stated reads "not said yet" rather than
 * a plausible zero, because a plausible zero is indistinguishable from a fact.
 *
 * The written history is the *same component* the game screen uses — `<EventLog>` over a slice of the
 * log — so the sentence a player reads in a replay is assembled by the same table as the one they
 * read live (`EventLogLines.ts`). A second narrator is how the two would end up disagreeing.
 *
 * ## Opening at the end
 *
 * The slider starts at the last event, not the first: a player opening a replay of the game they are
 * in should see the table they just left, and step *back* from something they recognise. Position 0
 * is reachable in one keystroke (`Home`, or "First") and shows an empty ring, which is the honest
 * picture of a log that has said nothing yet.
 *
 * Nothing here animates and nothing blocks: a step is a state change drawn on the next frame, so
 * there is no flourish for `prefers-reduced-motion` to ask us to skip.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { asApiError, type ApiError, type GameView, type PlayerView } from "@/api";
import { seatOf, Token, TOKEN_PX } from "@/board";
import { useGameContext } from "@/game/useGame";
import { EventLog } from "@/panels/EventLog";
import { ModalDialog } from "@/panels/ModalDialog";
import { EmptyState, ErrorState, LoadingState } from "@/panels/States";

import { ReplayBoard } from "./ReplayBoard";
import { ReplayControls } from "./ReplayControls";
import { factsAt, seatFacts, type ReplayFacts } from "./replayFacts";
import { useTileName, type TileNameLookup } from "./tileNames";

export interface ReplayPanelProps {
  readonly onClose: () => void;
}

export function ReplayPanel({ onClose }: ReplayPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const { client, gameId } = useGameContext();

  const [snapshot, setSnapshot] = useState<GameView | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  /** Bumped by the retry, which is the only way this effect runs twice. */
  const [attempt, setAttempt] = useState(0);
  /** `null` until the log arrives, because "the end of the log" is not known before then. */
  const [position, setPosition] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setFailure(null);
    void client
      .getGame(gameId, 0, controller.signal)
      .then((view) => {
        if (live) {
          setSnapshot(view);
          setPosition(view.events.length);
        }
      })
      .catch((cause: unknown) => {
        // The abort on unmount rejects this promise too, and `live` is what tells the two apart:
        // reporting "the network failed" about a panel the player has just closed would be a
        // failure invented by the cleanup.
        if (live) {
          setFailure(asApiError(cause));
        }
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [client, gameId, attempt]);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  return (
    <ModalDialog title={t("replay.title")} onClose={onClose}>
      {failure !== null ? (
        <ErrorState error={failure} onRetry={retry} testId="replay-error" />
      ) : snapshot === null ? (
        <LoadingState testId="replay-loading" />
      ) : (
        <ReplayBody
          snapshot={snapshot}
          position={Math.min(position ?? 0, snapshot.events.length)}
          onSeek={setPosition}
        />
      )}
    </ModalDialog>
  );
}

/**
 * The viewer proper, once there is a log to walk.
 *
 * Split out so that every field below can be read from a *present* snapshot rather than through an
 * optional chain — and so the fold runs on a value that cannot be `null`.
 */
function ReplayBody({
  snapshot,
  position,
  onSeek,
}: {
  readonly snapshot: GameView;
  readonly position: number;
  readonly onSeek: (position: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const seatsHeadingId = useId();
  const tileName = useTileName(snapshot.board);

  const events = snapshot.events;
  const facts = useMemo(() => factsAt(events, position), [events, position]);

  if (events.length === 0) {
    // A game that has been created and not yet played. Nothing to step through, and a slider with
    // one position on it would be a control that cannot do anything.
    return <EmptyState messageKey="replay.empty" testId="replay-empty" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <ReplayControls position={position} total={events.length} onSeek={onSeek} />

      <FrameSummary facts={facts} players={snapshot.state.players} />

      <ReplayBoard board={snapshot.board} players={snapshot.state.players} facts={facts} />

      <section aria-labelledby={seatsHeadingId} className="flex flex-col gap-2">
        <h3
          id={seatsHeadingId}
          className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70"
        >
          {t("replay.seats")}
        </h3>
        <ul data-testid="replay-seats" className="flex flex-col gap-2">
          {snapshot.state.players.map((player) => (
            <SeatRow
              key={player.id}
              player={player}
              players={snapshot.state.players}
              facts={facts}
              tileName={tileName}
            />
          ))}
        </ul>
      </section>

      {/*
        The written history, up to this position — the game screen's own log component over a slice.
        `maxEntries` is left at its default: the slice is already bounded by where the slider is.
      */}
      <EventLog
        events={events.slice(0, position)}
        players={snapshot.state.players}
        board={snapshot.board}
      />
    </div>
  );
}

/** Whose turn, which turn, and the last throw — each shown only if an event said so. */
function FrameSummary({
  facts,
  players,
}: {
  readonly facts: ReplayFacts;
  readonly players: readonly PlayerView[];
}): React.JSX.Element {
  const { t } = useTranslation();

  if (facts.applied === 0) {
    return <EmptyState messageKey="replay.nothing_yet" testId="replay-nothing-yet" />;
  }

  const acting = players.find((player) => player.id === facts.actingPlayer);
  return (
    <p data-testid="replay-frame" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      {facts.turnNumber !== undefined && (
        <span className="font-semibold">{t("label.turn", { number: facts.turnNumber })}</span>
      )}
      {acting !== undefined && <span>{acting.name}</span>}
      {facts.dice !== undefined && (
        <span className="opacity-80">
          {t("replay.throw", {
            first: facts.dice.first,
            second: facts.dice.second,
            total: facts.dice.total,
          })}
        </span>
      )}
    </p>
  );
}

/**
 * One seat, as the log has described it.
 *
 * Three values, and each of them is either a fact an event stated or the words "not said yet". There
 * is no fourth column for net worth or for holdings: no event states either, and the dossier that
 * does is a view of *now* — putting it beside a turn-three frame would be two different moments in
 * one row.
 */
function SeatRow({
  player,
  players,
  facts,
  tileName,
}: {
  readonly player: PlayerView;
  readonly players: readonly PlayerView[];
  readonly facts: ReplayFacts;
  readonly tileName: TileNameLookup;
}): React.JSX.Element {
  const { t } = useTranslation();
  const seat = seatOf(players, player.id);
  const stated = seatFacts(facts, player.id);
  const unstated = t("replay.unstated");

  return (
    <li
      data-testid="replay-seat"
      data-player={player.id}
      className="bg-tile text-ink border-hairline flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-sm"
    >
      {seat !== undefined && <Token seat={seat} size={TOKEN_PX.inline} />}
      <span className="font-semibold">{player.name}</span>

      <span className="flex items-baseline gap-1">
        <span className="text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
          {t("replay.square")}
        </span>
        <span data-testid="replay-seat-square">
          {stated.position === undefined ? unstated : tileName(stated.position)}
        </span>
      </span>

      <span className="flex items-baseline gap-1">
        <span className="text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
          {t("label.cash")}
        </span>
        {/* Latin numerals stay LTR inside a Hebrew page (GAP G-43). */}
        <span data-testid="replay-seat-cash" dir={stated.cash === undefined ? undefined : "ltr"}>
          {stated.cash === undefined ? unstated : stated.cash}
        </span>
      </span>

      {stated.inJail === true && <span className="font-semibold">{t("label.in_jail")}</span>}
      {stated.bankrupt === true && <span className="font-semibold">{t("label.bankrupt")}</span>}
    </li>
  );
}
