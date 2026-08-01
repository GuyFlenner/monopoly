/**
 * A square's translated name, with the guard every caller of this lookup needs.
 *
 * Square names live in a namespace per board (`board-classic`, `board-israel`), which is what lets
 * board choice and language vary independently — and `board-israel` is a *declared* board with no
 * catalogue until MON-503 (GAP G-46). `missingKeyHandler` throws under dev and test by design
 * (G-F17), so an unguarded lookup would take the whole replay down over one unnamed square.
 *
 * The replay needs the same lookup in two places — the board draws the name on a square, the seat
 * list says which square a token is standing on — and one shared hook is the difference between the
 * two agreeing by construction and agreeing by coincidence.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView } from "@/api";

export type TileNameLookup = (index: number) => string;

export function useTileName(board: BoardView): TileNameLookup {
  const { t, i18n } = useTranslation();
  return useCallback(
    (index: number) => {
      const nameKey = board.tiles[index]?.name_key;
      if (nameKey === undefined) {
        return t("label.unknown_square");
      }
      const scoped = `board-${board.id}:${nameKey}`;
      return i18n.exists(scoped) ? t(scoped) : t("label.unknown_square");
    },
    [board, t, i18n],
  );
}
