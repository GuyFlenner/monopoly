/**
 * The board as the events describe it — not the board as it is (MON-705).
 *
 * ## Why this is not `<Board>`
 *
 * `<Board>` takes a `GameStateView`: the projection, with every derived figure the engine ships in
 * it. A replay has no projection. It has an event log, and the only honest input to draw from is
 * {@link ReplayFacts} — the facts the events stated (`replayFacts.ts`). Building a `GameStateView`
 * out of those to satisfy `<Board>`'s signature would mean filling in `net_worth`, `rent_quotes`,
 * `houses_remaining` and a phase with *invented* values, and the moment anything downstream read one
 * of them the viewer would be showing a number nobody computed. So the squares are laid out here and
 * only the fields the events assert are handed to `<Tile>`.
 *
 * Everything reusable **is** reused: `PLACEMENTS` for the ring, `<Tile>` for a square's face,
 * `describeTile` for its accessible name, `useBoardMetrics` for the token-crowding measurement,
 * `board.css` for the felt and the printed marks. There is one board *design* in this product; what
 * differs here is where the facts come from.
 *
 * ## What "unstated" looks like
 *
 * Nothing. A square no event has mentioned has no owner marker and no houses; a token no
 * `token_moved` has placed is not on the board at all. That is the point of the whole feature: at
 * position 0 the ring is empty, because at position 0 the log has said nothing — and a viewer that
 * seeded the start of a game from board data would be asserting a fact it was never given.
 *
 * `undefined` reaches `<Tile>` as the projection's own idle values (`owner: null`, `houses: 0`,
 * `mortgaged: false`), which is a rendering decision and not a claim: `<Tile>` draws nothing for any
 * of the three.
 *
 * ## No live region, one grid, ids of its own
 *
 * The same three rules `<Board>` follows. No `aria-live` (the root `<Announcer>` owns narration);
 * `role="grid"` with rows and cells so the ring is one composite widget rather than forty stops; and
 * `kesef-replay-tile-…` ids, because the live board is still mounted behind this panel and two
 * elements with one id is an axe violation as well as invalid HTML.
 *
 * No square here is interactive. A replay is a record — there is nothing to click a square *for*,
 * and a detail sheet over a past frame would have to explain rent it cannot know.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView, PlayerView } from "@/api";
import {
  describeTile,
  GRID_SPAN,
  PLACEMENTS,
  seatOf,
  Tile,
  useBoardMetrics,
  type PropertyProjection,
  type TokenOccupant,
  type Translate,
} from "@/board";
import "@/board/board.css";

import { seatFacts, squareFacts, type ReplayFacts } from "./replayFacts";
import { useTileName } from "./tileNames";

export interface ReplayBoardProps {
  /** Static board data — square names, kinds, groups, prices. The same for every position. */
  readonly board: BoardView;
  /** The seats, for names and seat order only. Never for cash or position: those are `facts`. */
  readonly players: readonly PlayerView[];
  readonly facts: ReplayFacts;
}

function cellDomId(index: number): string {
  return `kesef-replay-tile-${String(index)}`;
}

export function ReplayBoard({ board, players, facts }: ReplayBoardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { measure, tileInlineSize } = useBoardMetrics();

  const translate = useCallback<Translate>((key, params) => t(key, params ?? {}), [t]);

  // The same guarded lookup the seat list uses, so the name on a square and the name beside a token
  // are one lookup rather than two that agree by luck.
  const tileName = useTileName(board);

  const playerName = useCallback(
    (playerId: number) => players.find((player) => player.id === playerId)?.name ?? t("label.player"),
    [players, t],
  );

  /** Tokens, from the positions `token_moved` stated. A seat with no stated position is not drawn. */
  const occupants = useMemo(() => {
    const byTile = new Map<number, TokenOccupant[]>();
    for (const player of players) {
      const seat = seatOf(players, player.id);
      const seen = seatFacts(facts, player.id);
      if (seat === undefined || seen.position === undefined || seen.bankrupt === true) {
        continue;
      }
      const standing = byTile.get(seen.position) ?? [];
      standing.push({ seat, name: player.name, isCurrent: player.id === facts.actingPlayer });
      byTile.set(seen.position, standing);
    }
    return byTile;
  }, [players, facts]);

  const overflowLabel = useCallback((hidden: number) => t("board.more_tokens", { hidden }), [t]);

  const tiles = useMemo(
    () => PLACEMENTS.filter((placement) => placement.index < board.tiles.length),
    [board.tiles.length],
  );

  const rows = useMemo(() => {
    const grouped = new Map<number, typeof tiles>();
    for (const placement of tiles) {
      const row = grouped.get(placement.row) ?? [];
      row.push(placement);
      grouped.set(placement.row, row);
    }
    return grouped;
  }, [tiles]);

  return (
    <div
      ref={measure}
      data-testid="replay-felt"
      className="kesef-felt relative mx-auto aspect-square w-full max-w-lg rounded-2xl p-[1.5%] shadow-lg"
    >
      {/*
        `dir="ltr"`, for the reason `Board.tsx` pins it: the ring's direction of travel is a property
        of the game, not of the reading order, so the grid must not mirror. See that file's docstring
        — this is the same exception, not a second one.
      */}
      <div
        dir="ltr"
        role="grid"
        aria-label={t("replay.board_label")}
        aria-rowcount={GRID_SPAN}
        aria-colcount={GRID_SPAN}
        data-testid="replay-board-grid"
        className="grid h-full w-full gap-[0.4%]"
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
                const stated = squareFacts(facts, placement.index);
                // The projection's own idle values for "no event has said". `<Tile>` draws nothing
                // for `null`, `0` and `false`, which is exactly what "unstated" should look like.
                const property: PropertyProjection = {
                  owner: stated.owner ?? null,
                  houses: stated.houses ?? 0,
                  mortgaged: stated.mortgaged ?? false,
                };
                const ownerSeat =
                  property.owner === null || property.owner === undefined
                    ? undefined
                    : seatOf(players, property.owner);
                const standing = occupants.get(placement.index) ?? [];
                return (
                  <div
                    key={placement.index}
                    // Both axes explicitly, for the reason `Board.tsx` gives: the bottom edge's
                    // columns descend, and grid's sparse auto-placement answers that by opening an
                    // implicit row per square.
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
                          ownerName:
                            property.owner === null || property.owner === undefined
                              ? undefined
                              : playerName(property.owner),
                          houses: property.houses,
                          mortgaged: property.mortgaged,
                          occupantNames: standing.map((occupant) => occupant.name),
                        },
                        translate,
                      )}
                      overflowLabel={overflowLabel}
                      // A record is read, not played. No square is a tap target and none roves.
                      interactive={false}
                      isActive={false}
                      domId={cellDomId(placement.index)}
                      ariaColIndex={placement.column}
                    />
                  </div>
                );
              })}
            </div>
          ))}
      </div>
    </div>
  );
}
