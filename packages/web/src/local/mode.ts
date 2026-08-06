/**
 * Which transport this page uses. Deliberately a file with no imports.
 *
 * `main.tsx` reads this to decide whether to `import("./local")` at all, so the local transport —
 * the route table, the fake socket, the Pyodide loader — is a chunk the server build never fetches.
 * If the check lived in `local/index.ts`, importing it in order to ask the question would already
 * have pulled in everything it answers about. Nothing here may gain an import for the same reason,
 * which is why {@link savedGameId} and {@link LOCAL_SAVE_KEY} live here rather than in
 * `rehydrate.ts`, where they are used: that file imports the bridge, and this one must not.
 *
 * ## One build, two modes (MON-727)
 *
 * `VITE_ENGINE=local` used to settle it outright, so a deployment was *either* same-screen or
 * online and the published site could only ever be the first. It still names the **default**, and
 * {@link bootsOnline} is the one case that overrides it: **a shared link to a game this browser
 * cannot possibly hold.**
 *
 * That is a fact rather than a preference, which is why it needs no setting and no extra screen. A
 * local game lives in one `localStorage` slot in the tab that created it (ADR-010). So a `?game=`
 * id that is *not* the id in that slot is a game this browser has never had and could not rehydrate
 * — the local engine would answer a truthful 404, which is exactly the "this game no longer exists"
 * failure ADR-010 exists to prevent. The only place such an id can have come from is somebody else's
 * address bar.
 *
 * The payoff is the whole point of the mode: a player opening a link **never fetches Pyodide**. The
 * ~12 MB is not merely unused on that path, it is never requested, because `main.tsx` takes the
 * branch that does not `import("./local")`.
 */

/** The value `VITE_ENGINE` must have for the rules engine to run in the browser (MON-805). */
export const LOCAL_ENGINE = "local";

/** The query parameter carrying the game. Mirrors `App.GAME_PARAM`, which cannot be imported here. */
const GAME_PARAM = "game";

/** Where the game in play is kept. Namespaced like every other key this app writes. */
export const LOCAL_SAVE_KEY = "kesef-street:local-save";

export function isLocalEngineBuild(
  mode: string | undefined = import.meta.env.VITE_ENGINE,
): boolean {
  return mode === LOCAL_ENGINE;
}

/**
 * The `game_id` inside a stored save, or `null` if the slot holds something that is not one.
 *
 * Read from `state.game_id`, which is where a `SaveFile` keeps it (ADR-011), and from the top level
 * as well — a slot written by the build before ADR-011 is a bare `GameState`, and it is *this*
 * function that decides whether that slot can still rescue a reload. Refusing it would throw away
 * the game of every player who had the tab open across the deploy, which is precisely the failure
 * ADR-010 exists to prevent.
 */
export function savedGameId(payload: string | null): string | null {
  if (payload === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const envelope = parsed as { game_id?: unknown; state?: { game_id?: unknown } };
    const id = envelope.state?.game_id ?? envelope.game_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    // A half-written slot from a tab that was closed mid-write. Treated as empty.
    return null;
  }
}

/** The saved game's id, or `null` — including when the browser refuses to be read at all. */
function localSaveId(): string | null {
  try {
    return savedGameId(globalThis.localStorage.getItem(LOCAL_SAVE_KEY));
  } catch {
    // Private mode throws on access, not only on write. A browser that will not answer is treated
    // as having no game, which sends a `?game=` link online — the right way to be wrong, since the
    // alternative strands a joiner on an engine that has never heard of the game.
    return null;
  }
}

/**
 * Where a game lives. Two values, and the vocabulary the whole app uses for the distinction.
 *
 * `same-screen` is the engine in this tab (MON-805); `online` is the HTTP API. Named for what a
 * *player* sees rather than for the transport — "local" is a word about where code runs, and the
 * setup screen has to ask a parent a question they can answer.
 */
export type Transport = "same-screen" | "online";

/**
 * Whether this build can offer the player a choice at all (MON-728).
 *
 * Both halves are required and they are different questions. `isLocalEngineBuild` says there *is* an
 * in-tab engine to choose between; an API URL says there is a server to choose instead. A build with
 * only one of them has nothing to ask about:
 *
 * - the dev/server build is already online, so a control offering "online" would be a no-op;
 * - a Pages build with no `VITE_API_URL` cannot reach a server, and {@link bootsOnline} would refuse
 *   to send it to one anyway — so an affordance here would create a game nobody could then join.
 *
 * Absent rather than disabled, on the same reasoning `SetupScreen.onLoad` uses: a control that
 * cannot work should not be on the screen explaining why.
 */
export function canPlayOnline({
  apiUrl = import.meta.env.VITE_API_URL,
  localBuild = isLocalEngineBuild(),
}: { readonly apiUrl?: string | undefined; readonly localBuild?: boolean } = {}): boolean {
  return localBuild && apiUrl !== undefined && apiUrl.trim() !== "";
}

/** What {@link bootsOnline} reads. Parameters so the decision is testable without a browser. */
export interface BootContext {
  /** `location.search`, for the `?game=` id. */
  readonly search?: string;
  /** `VITE_API_URL` — where an API lives, if this build was told of one. */
  readonly apiUrl?: string | undefined;
  /** The id of the game in this browser's local slot, or `null`. */
  readonly savedId?: string | null;
}

/**
 * Whether this page should talk to the API rather than to an engine in the tab.
 *
 * Three conditions, all required, and each one is a fact rather than a preference:
 *
 * 1. **There is a `?game=` id.** Without one the player is starting a game, and starting one
 *    same-screen is the default this mode does not override.
 * 2. **This build knows where an API is.** With no `VITE_API_URL` the online branch has nowhere to
 *    go, and booting into it would trade a working local game for a 404 against the page's own
 *    origin. A build that was never told about a server is never sent to one.
 * 3. **The id is not this browser's own game.** One slot, one game (ADR-010) — so an id that does
 *    not match it is a game this tab cannot rehydrate, and the local engine's honest answer would be
 *    "no such game".
 *
 * Note what is *not* here: no preference, no flag, no remembered choice. Every input is either in
 * the address bar, in the build, or in the one storage slot, so the same URL in the same browser
 * always boots the same way — which is what makes a shared link something a player can send.
 */
export function bootsOnline({
  search = globalThis.location.search,
  apiUrl = import.meta.env.VITE_API_URL,
  savedId = localSaveId(),
}: BootContext = {}): boolean {
  const gameId = new URLSearchParams(search).get(GAME_PARAM);
  if (gameId === null || gameId === "") {
    return false;
  }
  if (apiUrl === undefined || apiUrl.trim() === "") {
    return false;
  }
  return gameId !== savedId;
}
