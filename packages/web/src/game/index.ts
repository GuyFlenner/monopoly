/** The game-facing layer: one provider, one hook, one UI-local store. */

export { GameContext, GameProvider } from "./GameProvider";
export type { BackoffOverrides, GameContextValue, GameProviderProps } from "./GameProvider";
export { FULL_RULES_PRESENTATION, KIDS, presentationFor, type Presentation } from "./presentation";
export { queryKeys } from "./queryKeys";
export { useUiStore } from "./uiStore";
export type { PanelId, UiState } from "./uiStore";
export { useGame, useGameContext } from "./useGame";
export type { GameStatus, UseGameResult } from "./useGame";
export { useEventFeed } from "./useEventFeed";
