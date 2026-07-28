/**
 * Query keys, in one place.
 *
 * Hierarchical on purpose: `["game", id]` is a prefix of `["game", id, "save"]`, so
 * invalidating a game invalidates everything derived from it, and nothing belonging to
 * another game. Spelling a key inline at a call site is how two components end up caching
 * the same request under two names.
 */

export const queryKeys = {
  boards: () => ["boards"] as const,
  rulesets: () => ["rulesets"] as const,
  games: () => ["games"] as const,
  game: (gameId: string) => ["game", gameId] as const,
  /** The save file. Never rendered — see `types.ts` on `GameState`. */
  gameSave: (gameId: string) => ["game", gameId, "save"] as const,
} as const;
