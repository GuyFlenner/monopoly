/**
 * The wire between the event stream and the one `<Announcer>`.
 *
 * Called once, from whatever renders a live game. It subscribes to the de-duplicated event feed
 * (so a reconnect's replayed backlog is not read out a second time), maps each frame through the
 * pure narration table, and pushes the result. Order is preserved end to end: the frames arrive
 * in `seq` order, `narrate` returns its sentences in the order they happened, and the Announcer
 * says them one at a time.
 *
 * Names come from the projection: `state.players` for a seat, `board.tiles[i].name_key` for a
 * square. Both are lookups into what the server sent — there is nothing here to compute.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useEventFeed, useGame } from "@/game";
import { DECK_KEYS } from "@/panels/EventLogLines";

import type { AnnouncementDraft } from "./announcements";
import { useAnnounce } from "./AnnouncerContext";
import { narrate, type NarrationContext } from "./narration";

export function useEventNarration(): void {
  const { board, state } = useGame();
  const { t, i18n } = useTranslation();
  const announce = useAnnounce();

  const playerName = useCallback(
    (playerId: number) =>
      // The fallback is unreachable while board and state come from one view, and it is the id
      // rather than an invented name so that a contract change is visible instead of plausible.
      state?.players.find((player) => player.id === playerId)?.name ?? String(playerId),
    [state],
  );
  const tileName = useCallback(
    (tileIndex: number) => {
      const nameKey = board?.tiles[tileIndex]?.name_key;
      if (nameKey === undefined || board === undefined) {
        return String(tileIndex);
      }
      // Tile names live in a namespace per board (`board-classic`), which is what lets board
      // choice and language vary independently — the Israeli board in English is
      // `board-israel` + `en`. Resolving them against `common` would miss every one of them.
      return t(nameKey, { ns: `board-${board.id}` });
    },
    [board, t],
  );

  /**
   * A card's text (MON-709), guarded exactly as the log guards a server-supplied key.
   *
   * `card_id` comes from the *engine*, and `missingKeyHandler` throws under dev and test by design
   * (G-F17) — so a deck that has grown a card the catalogue has not must not take the narration down
   * with it. The fallback names the gap instead of speaking a raw key.
   */
  const cardText = useCallback(
    (cardId: string) => {
      const key = `cards:${cardId}`;
      return i18n.exists(key) ? t(key) : t("card_reveal.unnamed");
    },
    [t, i18n],
  );

  // The `deck.*` lookup lives here rather than in `narrate`, so the pure table keeps its property of
  // holding no enum labels — the same reason `EventLogLines` owns `DECK_KEYS` and shares it.
  const deckName = useCallback((deck: keyof typeof DECK_KEYS) => t(DECK_KEYS[deck]), [t]);

  const context: NarrationContext = { playerName, tileName, cardText, deckName };

  useEventFeed((frames) => {
    const drafts: AnnouncementDraft[] = [];
    for (const frame of frames) {
      drafts.push(...narrate(frame.event, context));
    }
    if (drafts.length > 0) {
      announce(drafts);
    }
  });
}
