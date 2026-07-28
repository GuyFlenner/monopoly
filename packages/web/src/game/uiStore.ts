/**
 * UI-local state, and nothing else.
 *
 * Which tile is selected, which player's dossier is open, which panel is showing. None of it
 * is game state: it survives a refetch unchanged, it is never sent to the server, and it is
 * never read back from one. Game state lives in the engine, reaches this package as a
 * projection, and is cached by TanStack Query — putting a cash balance or a legal-command list
 * in here would give the app two answers to the same question, and one of them would be stale.
 *
 * The rule of thumb: if the server could ever disagree with it, it does not belong in this
 * file.
 */

import { create } from "zustand";

export type PanelId = "dossier" | "trade" | "auction" | "log" | "tile" | "settings";

export interface UiState {
  /** Tile index, or `null` for nothing selected. */
  readonly selectedTile: number | null;
  /** Player id whose dossier is being read — any player, on anybody's turn (MON-406). */
  readonly selectedPlayer: number | null;
  readonly panel: PanelId | null;
  readonly selectTile: (index: number | null) => void;
  readonly selectPlayer: (playerId: number | null) => void;
  readonly openPanel: (panel: PanelId) => void;
  readonly closePanel: () => void;
  readonly clearSelection: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedTile: null,
  selectedPlayer: null,
  panel: null,
  selectTile: (index) => {
    set({ selectedTile: index });
  },
  selectPlayer: (playerId) => {
    set({ selectedPlayer: playerId });
  },
  openPanel: (panel) => {
    set({ panel });
  },
  closePanel: () => {
    set({ panel: null });
  },
  clearSelection: () => {
    set({ selectedTile: null, selectedPlayer: null });
  },
}));
