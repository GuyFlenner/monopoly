/**
 * The board: forty squares on an 11 x 11 grid, and one deliberate exception to the RTL rule.
 *
 * # The `dir="ltr"` exception — spec 5.1 as amended, GAP G-44
 *
 * **The grid container below is pinned `dir="ltr"`. It is the single deliberate physical-direction
 * exception in the whole web package, and it is a correctness fix rather than a shortcut.**
 *
 * `dir="rtl"` reverses a grid's inline axis, which reverses the visual order of the columns. Do that
 * here and column 1 becomes the right-hand edge, so the ring that runs GO -> 1 -> 2 -> ... would be
 * drawn the other way round and tokens would circle **clockwise in English and counter-clockwise in
 * Hebrew**. Direction of travel is a property of the *game*, not of the reading order (spec 5.3), so
 * mirroring it is not a translation — it is a rules change smuggled in as a layout change. The
 * original spec said mirroring the board was free; that sentence contradicted 5.3 and has been
 * withdrawn.
 *
 * What mirrors instead is the *text*: every square's content carries `dir="inherit"` (see
 * `Tile.tsx`), so a Hebrew name reads right-to-left inside a grid that does not flip, and the chrome
 * around the board — panels, the action bar, the log — mirrors normally because nothing here touches
 * it. Arrow keys are geometric for the same reason: the left arrow moves left on screen in both
 * languages, because in this one component "left" is a fixed direction.
 *
 * MON-707 asserts this **geometrically** — tile 0's bounding rect is identical in both locales —
 * rather than by reading the `dir` attribute back, which the same line of code would set and satisfy.
 *
 * # One tab stop, not forty — GAP G-E2
 *
 * The board is a single composite widget. `role="grid"` with roving `tabindex` above the interactive
 * breakpoint and `aria-activedescendant` below it (where no square may be focusable at all, because
 * no square can meet the 44 px floor — see `useBoardMetrics.ts`). Both modes share one navigation
 * function: arrows walk the ring, Home is GO, End is jail, Enter opens a square's detail. A
 * "skip to actions" link is the first focusable thing in the subtree, so a keyboard user never has
 * to cross the board to reach a button.
 *
 * # Requires a `<ThemeSprite>` ancestor
 *
 * Every square's colour band paints itself with `fill: url(#kesef-band-…)`, and those ten
 * `<pattern>` definitions live in the one `<ThemeSprite>` the app shell mounts at the root
 * (`App.tsx`) — the same way `<DiceTray>` requires an `<AnnouncerProvider>` above it rather than
 * carrying its own. **This component must not mount one of its own.** It did, and the document then
 * carried two elements for each of the ten pattern ids: harmless to look at, because `url(#id)`
 * resolves the first, and invalid HTML all the same. A `<Board>` rendered outside the shell — a
 * test, a story — supplies its own sprite as a sibling, which is the dependency being visible
 * rather than the duplicate coming back.
 *
 * # No rules, and no live region
 *
 * Every field drawn here comes off the projection — `owner`, `houses`, `mortgaged` — and nothing is
 * computed from them (ADR-005/ADR-008). And there is no `aria-live` anywhere in this subtree: the one
 * `<Announcer>` at the root owns narration, and a second region announcing the same roll is the
 * double-speak defect MON-411 exists to prevent (GAP G-D1/G-54).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView, GameStateView } from "@/api";
// The file, not `@/panels` — there is no barrel there, and importing one presentational leaf is
// what keeps this out of a cycle: `panels/TradeBuilder` imports `@/board`, and `States.tsx` imports
// nothing from either.
import { EmptyState } from "@/panels/States";

import {
  GRID_SPAN,
  INTERIOR_INSET,
  neighbour,
  PLACEMENTS,
  TILE_COUNT,
  type ScreenDirection,
} from "./geometry";
import { describeTile, seatOf, type PropertyProjection, type Translate } from "./projection";
import { Tile } from "./Tile";
import type { TokenOccupant } from "./Token";
import { useBoardMetrics } from "./useBoardMetrics";

import "./board.css";

/** GO. `Home` goes here, and it is where the ring starts on every board. */
const GO_INDEX = 0;

const ARROW_DIRECTION: Readonly<Record<string, ScreenDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/**
 * Presentation lag, and nothing else (MON-701).
 *
 * Two overrides, both with a fallback in the projection, so a board handed no motion at all draws
 * exactly what it drew before this existed. `positionOf` returning `undefined` for a player means
 * "that piece is not mid-journey, use `player.position`" — which is what makes a skipped animation
 * land on the truth without this component or the animation queue computing a square (see
 * `animation/queue.ts`'s idle contract).
 *
 * Neither field may ever be consulted for anything but where to draw a mark. There is no branch
 * below that reads a position to decide what a square costs, who owns it, or what is legal.
 */
export interface BoardMotion {
  /** Where a piece is being *drawn*, when that lags its true position. */
  readonly positionOf?: ((playerId: number) => number | undefined) | undefined;
  /** A beat per square, bumped when its buildings should pop. */
  readonly popNonce?: ((tile: number) => number | undefined) | undefined;
}

export interface BoardProps {
  readonly board: BoardView;
  readonly state: GameStateView;
  /** The animation queue's overrides. Omitted, every piece is drawn at its projected position. */
  readonly motion?: BoardMotion | undefined;
  /**
   * Opens a square's detail sheet. The board decides *which* square, never what the sheet says —
   * a detail panel that explained rent would be rule logic outside the engine.
   */
  readonly onOpenTile?: ((index: number) => void) | undefined;
  /** Where the "skip to actions" link jumps. The action bar is a sibling's component. */
  readonly actionsRegionId?: string;
  /** Rendered in the 9 x 9 interior well: the dice tray, the turn indicator. */
  readonly children?: ReactNode;
}

function cellDomId(index: number): string {
  return `kesef-tile-${String(index)}`;
}

export function Board({
  board,
  state,
  motion,
  onOpenTile,
  actionsRegionId = "kesef-actions",
  children,
}: BoardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { measure, tileInlineSize, interactive } = useBoardMetrics();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(GO_INDEX);
  // Focus follows the active square only when a key moved it. Without this the board would steal
  // focus on its first render, and again on every re-render a dice roll causes.
  const movedByKey = useRef(false);

  /** Squares are keyed by index; a board with fewer than forty draws fewer than forty. */
  const tiles = useMemo(
    () => PLACEMENTS.filter((placement) => placement.index < board.tiles.length),
    [board.tiles.length],
  );

  const occupants = useMemo(() => {
    const byTile = new Map<number, TokenOccupant[]>();
    for (const player of state.players) {
      // A bankrupt seat has no piece on the board. That is the projection's `bankrupt` flag being
      // read, not an inference about what bankruptcy means.
      const seat = seatOf(state.players, player.id);
      if (player.bankrupt || seat === undefined) {
        continue;
      }
      // Where the piece is *drawn*: the animation queue's square while it is travelling, and the
      // projection's own the rest of the time. `player.position` is the fallback rather than the
      // input, so the truth is what shows whenever nothing is in flight (MON-701).
      const drawnAt = motion?.positionOf?.(player.id) ?? player.position;
      const standing = byTile.get(drawnAt) ?? [];
      standing.push({ seat, name: player.name, isCurrent: player.id === state.current_player_id });
      byTile.set(drawnAt, standing);
    }
    return byTile;
  }, [state.players, state.current_player_id, motion]);

  // i18next's `t` narrowed to the two arguments `describeTile` uses, so that the description
  // builder can stay pure and be tested against a fake that echoes its own key.
  const translate = useCallback<Translate>((key, params) => t(key, params ?? {}), [t]);

  const playerName = useCallback(
    (playerId: number) =>
      state.players.find((player) => player.id === playerId)?.name ?? String(playerId),
    [state.players],
  );

  const tileName = useCallback(
    (index: number) => {
      const nameKey = board.tiles[index]?.name_key;
      // Square names live in a namespace per board, which is what lets board choice and language
      // vary independently. Resolving them against `common` would miss all forty.
      return nameKey === undefined ? String(index) : t(nameKey, { ns: `board-${board.id}` });
    },
    [board.id, board.tiles, t],
  );

  useEffect(() => {
    if (!movedByKey.current) {
      return;
    }
    movedByKey.current = false;
    if (!interactive) {
      // Narrow board: the grid itself holds focus and `aria-activedescendant` moves the cursor.
      return;
    }
    gridRef.current?.querySelector<HTMLElement>(`[data-tile-index="${String(active)}"]`)?.focus();
  }, [active, interactive]);

  const openTile = useCallback(
    (index: number) => {
      onOpenTile?.(index);
    },
    [onOpenTile],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const direction = ARROW_DIRECTION[event.key];
      if (direction !== undefined) {
        const next = neighbour(active, direction);
        if (next !== null) {
          movedByKey.current = true;
          setActive(next);
        }
        event.preventDefault();
        return;
      }
      switch (event.key) {
        case "Home":
          movedByKey.current = true;
          setActive(GO_INDEX);
          event.preventDefault();
          return;
        case "End":
          // Jail, from the board data rather than a hardcoded 10 — a different board may move it.
          movedByKey.current = true;
          setActive(Math.min(board.go_to_jail_target, TILE_COUNT - 1));
          event.preventDefault();
          return;
        case "Enter":
        case " ":
          openTile(active);
          event.preventDefault();
          return;
        default:
          return;
      }
    },
    [active, board.go_to_jail_target, openTile],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      // Below the breakpoint a square is not a tap target, so a click on one does nothing at all —
      // selection happens in the dossier list and through the detail button under the board.
      if (!interactive) {
        return;
      }
      const target =
        event.target instanceof Element ? event.target.closest("[data-tile-index]") : null;
      const raw = target?.getAttribute("data-tile-index");
      if (raw === null || raw === undefined) {
        return;
      }
      const index = Number.parseInt(raw, 10);
      if (Number.isNaN(index)) {
        return;
      }
      setActive(index);
      openTile(index);
    },
    [interactive, openTile],
  );

  // `{{hidden}}` rather than i18next's `{{count}}`: a `count` param triggers plural resolution and
  // would need a suffixed key per CLDR category in every language, and "+3" needs no grammar at all.
  const overflowLabel = useCallback((hidden: number) => t("board.more_tokens", { hidden }), [t]);

  const rows = useMemo(() => {
    const grouped = new Map<number, typeof tiles>();
    for (const placement of tiles) {
      const row = grouped.get(placement.row) ?? [];
      row.push(placement);
      grouped.set(placement.row, row);
    }
    return grouped;
  }, [tiles]);

  const properties: readonly PropertyProjection[] = state.properties;

  /*
    A board with no squares (MON-708).

    Unreachable through the picker — `catalogue_ready` is what keeps an unnamed board out of it, and
    every real board has forty tiles — but reachable through a **save file**, which is a `board_id`
    the player's disk supplied. Before this, a `BoardView` with an empty `tiles` array rendered the
    felt, the grid, the skip link and no squares: a green rectangle with the interior well floating
    in it, which is the "no blank whites" defect in a different colour. It says so instead, and the
    children still render, so the turn summary and the dice tray remain usable.

    `tiles.length === 0` is arithmetic on a projected array, not a rule. Nothing here decides what a
    board *should* contain.
  */
  if (board.tiles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3">
        <EmptyState messageKey="board.empty" />
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {/*
        The first focusable thing in the subtree. A keyboard user reaching the board should never
        have to walk it to get to a button — and on a narrow screen the grid is the only tab stop
        here, so this link is the escape hatch from it.
      */}
      <a
        href={`#${actionsRegionId}`}
        className="target bg-tile text-ink border-hairline sr-only rounded-lg border px-4 py-2 font-semibold focus:not-sr-only"
      >
        {t("board.skip_to_actions")}
      </a>

      <p id="kesef-board-hint" className="sr-only">
        {t("board.keyboard_hint")}
      </p>

      <div
        ref={measure}
        className="kesef-felt relative aspect-square w-full max-w-full rounded-2xl p-[1.5%] shadow-lg"
      >
        {/*
          ==========================================================================================
          THE ONE PHYSICAL-DIRECTION EXCEPTION IN packages/web — spec 5.1 as amended, GAP G-44.
          `dir="ltr"` is pinned here on purpose. Under `dir="rtl"` the grid's inline axis reverses,
          the columns swap ends, and tokens would travel clockwise in English but counter-clockwise
          in Hebrew — a change to the game, disguised as a change to the layout. Square *text*
          restores the document direction (`dir="inherit"` in `Tile.tsx`); the chrome around the
          board mirrors normally. Do not "fix" this by deleting it. Full reasoning: the module
          docstring above.
          ==========================================================================================
        */}
        <div
          dir="ltr"
          ref={gridRef}
          role="grid"
          aria-label={t("board.label")}
          aria-describedby="kesef-board-hint"
          aria-rowcount={GRID_SPAN}
          aria-colcount={GRID_SPAN}
          data-testid="board-grid"
          data-interactive={interactive}
          // Above the breakpoint the squares rove and the grid is not itself a tab stop; below it,
          // no square may be focusable, so the grid holds the single tab stop and points at the
          // active square instead (GAP G-C1/G-E2).
          tabIndex={interactive ? -1 : 0}
          aria-activedescendant={interactive ? undefined : cellDomId(active)}
          onKeyDown={handleKeyDown}
          onClick={handleClick}
          // `target` even though the grid is always far wider than 44 px: it makes "every tabbable
          // element in this subtree carries `.target`" an unconditional assertion rather than one
          // with an exception in it (see `targets.test.tsx`).
          className="target grid h-full w-full gap-[0.4%]"
          style={{
            gridTemplateRows: `repeat(${String(GRID_SPAN)}, minmax(0, 1fr))`,
            gridTemplateColumns: `repeat(${String(GRID_SPAN)}, minmax(0, 1fr))`,
          }}
        >
          {[...rows.entries()]
            .sort(([a], [b]) => a - b)
            .map(([row, placements]) => (
              <div
                key={row}
                role="row"
                aria-rowindex={row}
                // `kesef-board-row` carries the single block-axis track. Without it this nested grid
                // sizes itself to its content and the squares collapse — see `board.css`.
                className="kesef-board-row col-span-full grid gap-[0.4%]"
                style={{
                  gridRow: row,
                  gridTemplateColumns: `repeat(${String(GRID_SPAN)}, minmax(0, 1fr))`,
                }}
              >
                {placements.map((placement) => {
                  const tile = board.tiles[placement.index];
                  if (tile === undefined) {
                    return null;
                  }
                  const property = properties[placement.index];
                  const owner = property?.owner ?? null;
                  const ownerSeat = owner === null ? undefined : seatOf(state.players, owner);
                  const standing = occupants.get(placement.index) ?? [];
                  return (
                    <div
                      key={placement.index}
                      // Both axes, always. The row is one track tall, and the bottom edge's columns
                      // run 11 -> 2, which grid's sparse auto-placement answers by opening a new
                      // implicit row per square — ten squares staircasing out of the felt. An
                      // explicit `grid-row` means nothing here is auto-placed, so the order the
                      // squares are emitted in cannot move any of them (`Board.test.tsx`).
                      style={{ gridRow: 1, gridColumn: placement.column }}
                      className="h-full w-full"
                    >
                      <Tile
                        tile={tile}
                        property={property}
                        ownerSeat={ownerSeat}
                        occupants={standing}
                        rotation={placement.rotation}
                        isCorner={placement.isCorner}
                        inlineSize={tileInlineSize}
                        name={tileName(placement.index)}
                        description={describeTile(
                          {
                            name: tileName(placement.index),
                            kind: tile.kind,
                            ownerName: owner === null ? undefined : playerName(owner),
                            houses: property?.houses ?? 0,
                            mortgaged: property?.mortgaged ?? false,
                            occupantNames: standing.map((occupant) => occupant.name),
                          },
                          translate,
                        )}
                        overflowLabel={overflowLabel}
                        popNonce={motion?.popNonce?.(placement.index)}
                        interactive={interactive}
                        isActive={placement.index === active}
                        domId={cellDomId(placement.index)}
                        ariaColIndex={placement.column}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
        </div>

        {/*
          The interior well: one cell in from every edge. A single symmetric `inset` rather than
          four sides, because a symmetric inset has no start or end in it to get backwards.
        */}
        <div
          data-testid="board-interior"
          className="text-on-table absolute flex items-center justify-center"
          style={{ inset: `calc(1.5% + ${INTERIOR_INSET})` }}
        >
          {children}
        </div>
      </div>

      {/*
        The detail affordance that works at 320 px, where a square cannot be a tap target. It is a
        real button of its own, not a tooltip and not a long-press, and it always names the square it
        would open so nothing is hidden behind a hover.
      */}
      <button
        type="button"
        onClick={() => {
          openTile(active);
        }}
        className="target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 font-semibold shadow-sm"
      >
        {t("board.open_tile", { name: tileName(active) })}
      </button>
    </div>
  );
}
