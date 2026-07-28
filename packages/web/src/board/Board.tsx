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
import { ThemeSprite } from "@/theme";

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

export interface BoardProps {
  readonly board: BoardView;
  readonly state: GameStateView;
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
      const standing = byTile.get(player.position) ?? [];
      standing.push({ seat, name: player.name, isCurrent: player.id === state.current_player_id });
      byTile.set(player.position, standing);
    }
    return byTile;
  }, [state.players, state.current_player_id]);

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
  const overflowLabel = useCallback((hidden: number) => t("board.moreTokens", { hidden }), [t]);

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
        {t("board.skipToActions")}
      </a>

      {/* The pattern definitions every colour band references. Mounted once; see `patterns.tsx`. */}
      <ThemeSprite />

      <p id="kesef-board-hint" className="sr-only">
        {t("board.keyboardHint")}
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
                className="col-span-full grid gap-[0.4%]"
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
                      style={{ gridColumn: placement.column }}
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
        {t("board.openTile", { name: tileName(active) })}
      </button>
    </div>
  );
}
