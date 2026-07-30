/**
 * A game, to and from a file on the player's own disk (MON-704).
 *
 * `GameState` already serializes — the reducer's "the JSON is the save file" property, kept by
 * `GET /games/{id}/save` (ADR-008 §2) — so there is nothing to invent here. What is left is two
 * browser affordances and a name, and each of the three is a small decision worth writing down.
 *
 * ## The file is the one payload with hidden information
 *
 * The save carries `rng` and the shuffled deck order. That is fine for a local file — it is the
 * player's own game, and a save that omitted the deal could not be resumed — and it is **not** fine
 * on screen. So nothing in this package ever renders a `GameState`: it goes from `fetch` to a
 * `Blob` without being read, and comes back from a file to `POST /games/load` without being
 * inspected. `api/types.ts` says the same thing about the type; this is the code that honours it.
 *
 * ## Why there is a port
 *
 * Downloading a file is four DOM calls that jsdom implements partially and a browser implements
 * differently: `URL.createObjectURL`, an anchor with a `download` attribute, a synthetic click, and
 * a revoke. A test that drives them asserts on jsdom rather than on this product. So the four are
 * behind {@link SaveFilePort}, the default implementation is the browser's, and the test asserts on
 * the filename and the bytes — which is what a player actually gets.
 */

import { ApiError, NO_RESPONSE, type GameState } from "@/api";

/** Somewhere a save can be written. One call, no answers. */
export interface SaveFilePort {
  /** Offer `json` to the player as a download named `filename`. */
  save(filename: string, json: string): void;
}

/**
 * How a save file is named.
 *
 * `kesef-street-<game id>-turn-<n>.json`. The turn number is in the name because the whole point of
 * a save is to have more than one: a folder of `kesef-street-g1.json (2)` is a folder nobody can
 * choose from, whereas a turn number sorts and means something.
 *
 * The game id is sanitized even though the server's `GAME_ID_PATTERN` already forbids anything a
 * path would object to. Belt and braces on purpose: this function's input is a field on a JSON
 * document, this function's output is a filename, and "the other end validated it" is the reasoning
 * behind most path-traversal defects. Nothing is lost — an id that passes the server's pattern is
 * unchanged by the replacement.
 */
export function saveFileName(gameId: string, turnNumber: number): string {
  const safe = gameId.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `kesef-street-${safe}-turn-${String(turnNumber)}.json`;
}

/**
 * The bytes of a save file.
 *
 * Two-space indentation rather than the compact form: a save file is a thing a player might open,
 * and a bug report is much more useful with one. The cost is a few kilobytes of a file that is
 * written once.
 */
export function saveFileContents(state: GameState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * The browser's download, as one call.
 *
 * The object URL is revoked immediately after the click. That is safe — the browser has already
 * taken its own reference to the blob by then — and skipping it leaks the whole save for the life of
 * the document, which for a long game is not a rounding error.
 */
export function browserSaveFilePort(): SaveFilePort {
  return {
    save: (filename, json) => {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      // Not appended to the document. A detached anchor's `click()` still starts a download in every
      // browser this product supports, and appending one means a visible artefact in the DOM that a
      // layout or a snapshot test can trip over.
      anchor.click();
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * A file the player chose, parsed.
 *
 * Resolves with whatever the JSON says — typed `unknown`, because at this point that is the honest
 * type: it is a stranger's file, and the only thing that may decide whether it is a `GameState` is
 * the engine's own model, on the far side of `POST /games/load`.
 *
 * Rejects with `error.save_unreadable` when the text is not JSON at all. That case is worth its own
 * key rather than being posted for the server to refuse: a photograph renamed to `.json` is not a
 * save from a different version of the game, and telling a parent it is would send them looking for
 * an upgrade that does not exist.
 */
export const UNREADABLE_SAVE_KEY = "error.save_unreadable";

/**
 * Thrown as an `ApiError` with status {@link NO_RESPONSE} — no request was made, so there is no
 * status to report — which is what lets a screen render it through the same `<ErrorState>` and the
 * same `useReasonText` as a refusal from the server. The key is what distinguishes it: `error.network`
 * is the fallback for a failure nobody named, and this one has a name.
 */
export async function readSaveFile(file: Blob): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(NO_RESPONSE, UNREADABLE_SAVE_KEY);
  }
}
