/**
 * The written history of the game. Newest first, scrollable, and **silent**.
 *
 * The silence is the design decision worth naming. A log is the obvious place to put an
 * `aria-live` region, and MON-407 originally asked for one — but MON-411's `<Announcer>`
 * already narrates the dice, the movement, the rent and the money, and a second region
 * announcing the same roll makes a screen reader say everything twice (GAP D1/G-54). So this
 * component renders visual history only: no `aria-live`, and no `role="log"` or `role="status"`
 * either, both of which carry an implicit live region that the attribute audit would miss.
 * There is a test for exactly that.
 *
 * Every line is a catalogue sentence built from the event's own parameters (see
 * `EventLogLines.ts`). Nothing here reads current state, so scrolling back to turn 3 shows what
 * turn 3 cost rather than what the same property costs now.
 *
 * *Visual direction*: a printed ledger card on the felt — cream stock, hairline rules, a
 * perforated inline-start spine that turn boundaries tear across. The spine is the one
 * flourish; the rows are deliberately plain, because the log is read, not admired.
 */

import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView, LoggedEvent, PlayerView } from "@/api";

import { linesFor, type LineContext, type LogLine } from "./EventLogLines";

export interface EventLogProps {
  /** The de-duplicated log from `useGame`, oldest first. Reversed for display, not mutated. */
  readonly events: readonly LoggedEvent[];
  /** Seats, for name lookup only. A log line never reads a seat's cash or position. */
  readonly players: readonly PlayerView[];
  /** The board, for tile-name lookup. `undefined` before the first view arrives. */
  readonly board: BoardView | undefined;
  /** How many rows to keep in the DOM. The newest ones win. */
  readonly maxEntries?: number;
}

/**
 * Enough rows to scroll back through a long game, few enough that a phone can hold them.
 *
 * The event queue caps itself as well (`api/eventQueue.ts`), so this is a rendering budget
 * rather than a retention policy.
 */
export const DEFAULT_MAX_ENTRIES = 200;

export function EventLog({
  events,
  players,
  board,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: EventLogProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const headingId = useId();

  const context = useMemo<LineContext>(
    () => ({
      // A seat the log has never heard of is a real case: a save loaded mid-game, or a frame
      // that arrived a beat before the view naming its player. `label.player` is honest about
      // not knowing, where `players[id]!.name` would throw in front of a child.
      playerName: (playerId) =>
        players.find((player) => player.id === playerId)?.name ?? t("label.player"),
      // Tile names live in a namespace per board (`board-classic`, `board-israel`), which is
      // what lets board choice and language be independent — so the key has to be qualified,
      // and `board-israel` is a *declared* board with no catalogue until MON-503 (GAP G-46).
      // A log line that says "a space on the board" is worse than the tile's name and far
      // better than a thrown missing-key taking the panel down.
      tileName: (tileIndex) => {
        const tile = board?.tiles.find((candidate) => candidate.index === tileIndex);
        if (tile === undefined || board === undefined) {
          return t("log.unknown_tile");
        }
        const key = `board-${board.id}:${tile.name_key}`;
        return i18n.exists(key) ? t(key) : t("log.unknown_tile");
      },
      translate: (key, params) => t(key, params ?? {}),
    }),
    [players, board, t, i18n],
  );

  const rows = useMemo(() => linesFor(events, context, maxEntries), [events, context, maxEntries]);

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-tile text-ink shadow-[0_2px_0_0_oklch(0%_0_0/0.10),0_10px_24px_-12px_oklch(0%_0_0/0.45)] dark:bg-[oklch(27%_0.02_255)] dark:text-[oklch(95%_0.008_95)]"
    >
      <h2
        id={headingId}
        className="border-b border-dashed border-current/20 px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] opacity-70"
      >
        {t("log.title")}
      </h2>

      {/*
        A scrollable box has to be reachable by keyboard or its content is unreachable without
        a mouse — axe reports exactly that as `scrollable-region-focusable`, and the E4 gate is
        "axe clean". It carries no role of its own: the `<section>` above is already the named
        region, and a second one with the same name is two landmarks for one panel.
      */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
        {rows.length === 0 ? (
          <p className="py-6 text-sm opacity-70">{t("log.empty")}</p>
        ) : (
          <ol className="flex flex-col">
            {rows.map(({ seq, line }) =>
              line.shape === "turn" ? (
                <TurnMarker key={seq} line={line} />
              ) : (
                <Entry key={seq} line={line} translate={t} exists={i18n.exists.bind(i18n)} />
              ),
            )}
          </ol>
        )}
      </div>
    </section>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];
type Exists = (key: string, options?: { readonly count?: number }) => boolean;

function Entry({
  line,
  translate,
  exists,
}: {
  readonly line: LogLine;
  readonly translate: Translate;
  readonly exists: Exists;
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-3 border-s-2 border-dashed border-current/20 py-2 ps-3">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-current/10 text-xs"
      >
        {line.icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm leading-snug">{sentence(line, translate, exists)}</p>
        {line.notes.length > 0 && (
          // The engine's own explanation of the figure, not a second calculation of it. Spec
          // §5.5: every rent can be explained, and `rent.note.*` keys exist for this line.
          <ul className="flex flex-col gap-0.5 text-xs opacity-75">
            {line.notes.map((note) => (
              <li key={note.key}>{sentence(note, translate, exists)}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * A turn boundary, drawn as a tear across the spine.
 *
 * Numbering is earned here and nowhere else in this component: turns *are* a sequence, and in a
 * newest-first list this row is the floor of the turn above it — scroll past it and you have
 * left that turn behind.
 */
function TurnMarker({ line }: { readonly line: LogLine }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="h-px flex-1 bg-current/25" />
      <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] opacity-80">
        {t(line.key, line.params)}
      </span>
      <span className="h-px flex-1 bg-current/25" />
    </li>
  );
}

/**
 * Resolve one line to text.
 *
 * The `exists` guard is for keys that arrive from the server rather than from this package —
 * a `rent.note.*` the engine emits before the catalogue has it. `missingKeyHandler` throws in
 * dev and test (by design, GAP G-F17), so an unguarded `t()` would take the whole panel down
 * over one missing explanation. Dropping the note loses an explanation; throwing loses the
 * game.
 */
function sentence(line: LogLine, translate: Translate, exists: Exists): string {
  // `count` has to be part of the existence check as well as the lookup: a pluralized key
  // lives in the catalogue as `…_one`/`…_other` and its base form exists in neither.
  if (line.count === undefined) {
    return exists(line.key) ? translate(line.key, line.params) : "";
  }
  return exists(line.key, { count: line.count })
    ? translate(line.key, { ...line.params, count: line.count })
    : "";
}
