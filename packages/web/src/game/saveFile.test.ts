/**
 * Save files, in and out (MON-704).
 *
 * The naming and the parsing are pure, so they are tested directly. The *download* is four DOM
 * calls that jsdom implements partially — so it is behind a port, and what is asserted through the
 * port is what a player actually receives: a filename and the bytes.
 */

import { describe, expect, it } from "vitest";

import { ApiError, NO_RESPONSE } from "@/api";
import { makeState } from "@/test/fixtures";
import type { GameState } from "@/api";

import {
  readSaveFile,
  saveFileContents,
  saveFileName,
  UNREADABLE_SAVE_KEY,
  type SaveFilePort,
} from "./saveFile";

/**
 * A `GameState` is the *engine's* model, not the projection, and no fixture builds one — nothing
 * else in this package is allowed to read it (see `api/types.ts`). Only two fields are touched here,
 * so a projection with the deck order bolted on carries them without pretending to be complete.
 */
function saveShaped(overrides: Partial<{ game_id: string; turn_number: number }> = {}): GameState {
  return {
    ...makeState(),
    ...overrides,
    rng: { seed: 7, counter: 3 },
    chance_deck: ["chance_advance_to_go"],
  } as unknown as GameState;
}

describe("saveFileName", () => {
  it("names a file after the game and the turn it captured", () => {
    // The turn number is in the name because the whole point of a save is to have more than one: a
    // folder of "kesef-street-g1.json (2)" is a folder nobody can choose from.
    expect(saveFileName("kitchen-table", 14)).toBe("kesef-street-kitchen-table-turn-14.json");
  });

  it("never lets a game id become a path", () => {
    // The server's `GAME_ID_PATTERN` already forbids this, and "the other end validated it" is the
    // reasoning behind most path-traversal defects. Input: a field on a JSON document. Output: a
    // filename. So it is sanitized here too.
    // The separators are gone; the dots survive, because a dot is legal in a `game_id` and legal in
    // a filename — what makes `..` dangerous is the separator beside it, and that is what went.
    expect(saveFileName("../../etc/passwd", 1)).toBe("kesef-street-..-..-etc-passwd-turn-1.json");
    expect(saveFileName("a b/c", 1)).toBe("kesef-street-a-b-c-turn-1.json");
    expect(saveFileName("C:\\Windows\\system32", 1)).toBe(
      "kesef-street-C--Windows-system32-turn-1.json",
    );
  });

  it("leaves an id the server would have accepted untouched", () => {
    // Nothing is lost by the belt-and-braces: every id that passes the server's pattern survives.
    for (const id of ["g1", "kitchen-table", "Game_2026.07.30", "abc-123"]) {
      expect(saveFileName(id, 2)).toBe(`kesef-street-${id}-turn-2.json`);
    }
  });
});

describe("saveFileContents", () => {
  it("writes indented JSON that parses back to the same state", () => {
    const state = saveShaped();
    const written = saveFileContents(state);

    // Indented because a save file is a thing a player might open, and a bug report is much more
    // useful with one. The cost is a few kilobytes of a file written once.
    expect(written).toContain("\n  ");
    expect(JSON.parse(written)).toEqual(state);
  });

  it("keeps the hidden information, because a save without the deal cannot be resumed", () => {
    // The one payload that carries the deck order and the RNG (ADR-008 §2). Fine in a local file;
    // the discipline is that nothing *renders* it, not that it is stripped.
    const written = JSON.parse(saveFileContents(saveShaped())) as Record<string, unknown>;
    expect(written["rng"]).toEqual({ seed: 7, counter: 3 });
    expect(written["chance_deck"]).toEqual(["chance_advance_to_go"]);
  });
});

describe("readSaveFile", () => {
  it("parses a chosen file into whatever the JSON says", async () => {
    const state = saveShaped();
    const file = new Blob([saveFileContents(state)], { type: "application/json" });
    await expect(readSaveFile(file)).resolves.toEqual(state);
  });

  it("does not judge whether the JSON is a game", async () => {
    // Deliberately: whether a document is a `GameState`, and whether its `schema_version` is
    // current, are the engine's questions — answered on the far side of `POST /games/load` as
    // `error.save_schema_mismatch`. A check here would be a second opinion about the engine's
    // schema, held by the layer least able to keep it current.
    await expect(readSaveFile(new Blob(['{"not":"a game"}']))).resolves.toEqual({ not: "a game" });
  });

  it("refuses a file that is not JSON at all, with its own key", async () => {
    // A photograph renamed to `.json` is not a save from a different version of the game, and
    // telling a parent it is would send them looking for an upgrade that does not exist.
    const failure = await readSaveFile(new Blob(["PNG\r\n\n"])).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).reasonKey).toBe(UNREADABLE_SAVE_KEY);
    // No request was made, so there is no status to report. The *key* is what distinguishes this
    // from a network failure — `error.network` is the fallback for a failure nobody named.
    expect((failure as ApiError).status).toBe(NO_RESPONSE);
  });
});

describe("a SaveFilePort", () => {
  it("receives the filename and the bytes, which is what the player gets", () => {
    // The seam. A test that drove `URL.createObjectURL` and a synthetic anchor click would be
    // asserting on jsdom rather than on this product.
    const offered: { filename: string; json: string }[] = [];
    const port: SaveFilePort = {
      save: (filename, json) => {
        offered.push({ filename, json });
      },
    };
    const state = saveShaped({ game_id: "kitchen-table", turn_number: 9 });

    port.save(saveFileName(state.game_id, state.turn_number), saveFileContents(state));

    expect(offered).toHaveLength(1);
    expect(offered[0]?.filename).toBe("kesef-street-kitchen-table-turn-9.json");
    expect(JSON.parse(offered[0]?.json ?? "null")).toEqual(state);
  });
});
