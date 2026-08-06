/**
 * Query keys, in one place.
 *
 * Hierarchical on purpose: `["game", id]` is a prefix of `["game", id, "save"]`, so
 * invalidating a game invalidates everything derived from it, and nothing belonging to
 * another game. Spelling a key inline at a call site is how two components end up caching
 * the same request under two names.
 */

/**
 * The two lists are scoped by transport (MON-728).
 *
 * They are the only pre-game requests, and the only ones that can be asked of *either* engine in one
 * session: ticking "people elsewhere" on the setup screen swaps the client under a screen that has
 * already fetched them. Without the scope the cache would serve the in-tab engine's answer for a
 * question now being asked of the server — which is invisible while the two agree and a wrong board
 * list the moment a deployed server is a version ahead of the wheels.
 *
 * A game is *not* scoped: an id belongs to exactly one engine, so `["game", id]` cannot collide with
 * the same id elsewhere. Scoping it would only make the key longer.
 */
export const queryKeys = {
  boards: (transport: string) => ["boards", transport] as const,
  rulesets: (transport: string) => ["rulesets", transport] as const,
  games: () => ["games"] as const,
  game: (gameId: string) => ["game", gameId] as const,
  /** The save file. Never rendered — see `types.ts` on `GameState`. */
  gameSave: (gameId: string) => ["game", gameId, "save"] as const,
} as const;
