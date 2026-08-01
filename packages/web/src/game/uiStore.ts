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

/**
 * How many dossiers the compare tray will hold (MON-702).
 *
 * Three, and the ceiling is a *layout* fact rather than a rule: a fourth card takes a compact
 * dossier below the width its four figures and its deed names need, so the tray would be scrolling
 * horizontally to show cards nobody can read. The tray scrolls anyway on a narrow screen — that is
 * what `overflow-x` is for — but a limit that exists to keep the cards legible is a limit worth
 * enforcing in one place rather than in each button that could add one.
 */
export const MAX_PINNED_PLAYERS = 3;

export interface UiState {
  /** Tile index, or `null` for nothing selected. */
  readonly selectedTile: number | null;
  /** Player id whose dossier is being read — any player, on anybody's turn (MON-406). */
  readonly selectedPlayer: number | null;
  readonly panel: PanelId | null;
  /**
   * Seats pinned side by side in the compare tray, in the order they were pinned (MON-702).
   *
   * Pin *order*, not seat order, because the player chose it: pinning Dan and then Ruti puts Dan
   * first, and re-sorting the tray under someone who has just pinned a card is how a comparison
   * loses its place. At most {@link MAX_PINNED_PLAYERS} entries, enforced here.
   */
  readonly pinnedPlayers: readonly number[];
  readonly selectTile: (index: number | null) => void;
  readonly selectPlayer: (playerId: number | null) => void;
  readonly openPanel: (panel: PanelId) => void;
  readonly closePanel: () => void;
  readonly clearSelection: () => void;
  /** Pin, or unpin if already pinned. A no-op at the ceiling — see {@link MAX_PINNED_PLAYERS}. */
  readonly togglePin: (playerId: number) => void;
  readonly unpinPlayer: (playerId: number) => void;
  readonly clearPinned: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedTile: null,
  selectedPlayer: null,
  panel: null,
  pinnedPlayers: [],
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
  togglePin: (playerId) => {
    set((state) => {
      if (state.pinnedPlayers.includes(playerId)) {
        return { pinnedPlayers: state.pinnedPlayers.filter((id) => id !== playerId) };
      }
      if (state.pinnedPlayers.length >= MAX_PINNED_PLAYERS) {
        // Silent here, said out loud there: the button that was pressed announces the ceiling
        // through the root `<Announcer>`, because it is the thing that knows a person pressed it.
        return {};
      }
      return { pinnedPlayers: [...state.pinnedPlayers, playerId] };
    });
  },
  unpinPlayer: (playerId) => {
    set((state) => ({ pinnedPlayers: state.pinnedPlayers.filter((id) => id !== playerId) }));
  },
  clearPinned: () => {
    set({ pinnedPlayers: [] });
  },
}));
