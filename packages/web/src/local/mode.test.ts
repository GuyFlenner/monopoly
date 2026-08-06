/**
 * What must be true of the boot decision (MON-727).
 *
 * This is the smallest module in the package and the one with the most expensive failure modes, in
 * both directions:
 *
 * - **Too eager** and a player mid-game reloads into the API, which has never heard of their
 *   same-screen game — the ADR-010 failure ("this game no longer exists") arriving by a new route.
 * - **Too shy** and a shared link boots the local engine, which answers a truthful 404 for a game it
 *   cannot have, after making the joiner wait for ~12 MB of Pyodide to tell them so.
 *
 * So the table below is exhaustive over the three inputs rather than illustrative, and every
 * condition has a test that fails if it is dropped.
 */

import { describe, expect, it } from "vitest";

import { bootsOnline, isLocalEngineBuild, LOCAL_ENGINE, savedGameId } from "./mode";

const API = "https://kesef-street-api.onrender.com";

describe("isLocalEngineBuild", () => {
  it("recognises only the one value the deploy sets", () => {
    expect(isLocalEngineBuild(LOCAL_ENGINE)).toBe(true);
    expect(isLocalEngineBuild(undefined)).toBe(false);
    expect(isLocalEngineBuild("")).toBe(false);
    expect(isLocalEngineBuild("server")).toBe(false);
    expect(isLocalEngineBuild("Local")).toBe(false);
  });
});

describe("bootsOnline", () => {
  it("sends a shared link to the API", () => {
    // The case the mode exists for: an id this browser has never held, and a server that has.
    expect(bootsOnline({ search: "?game=abc", apiUrl: API, savedId: null })).toBe(true);
  });

  it("keeps this browser's own game on the engine in the tab", () => {
    // A reload mid-game. The id matches the local slot, so the game is *here* and ADR-010's
    // rehydration is what should happen — booting online would lose it.
    expect(bootsOnline({ search: "?game=abc", apiUrl: API, savedId: "abc" })).toBe(false);
  });

  it("keeps a fresh visit local, because starting a game is what the default is for", () => {
    expect(bootsOnline({ search: "", apiUrl: API, savedId: null })).toBe(false);
    expect(bootsOnline({ search: "?lang=he", apiUrl: API, savedId: null })).toBe(false);
  });

  it("never sends a build that was told of no API", () => {
    /*
      The condition that keeps this safe to ship before the Pages build sets `VITE_API_URL`. With no
      server to go to, "online" means fetching the page's own origin, so a joiner would trade a
      404-from-the-engine for a 404-from-GitHub — worse, because the local build at least explains
      itself. A build that was never told about a server is never sent to one.
    */
    expect(bootsOnline({ search: "?game=abc", apiUrl: undefined, savedId: null })).toBe(false);
    expect(bootsOnline({ search: "?game=abc", apiUrl: "", savedId: null })).toBe(false);
    // Blank is unset, the same reading `defaultBaseUrl` gives it — `VITE_API_URL=` in CI is the
    // ordinary way this goes wrong.
    expect(bootsOnline({ search: "?game=abc", apiUrl: "   ", savedId: null })).toBe(false);
  });

  it("treats an empty id as no id", () => {
    expect(bootsOnline({ search: "?game=", apiUrl: API, savedId: null })).toBe(false);
  });

  it("sends a link that differs from a local game in progress", () => {
    // A player with their own same-screen game half-played opens somebody else's link. The saved
    // slot is not emptied and the local game is not lost; this visit is simply about another game.
    expect(bootsOnline({ search: "?game=xyz", apiUrl: API, savedId: "abc" })).toBe(true);
  });

  it("is decided by the url, the build and the slot — and by nothing remembered", () => {
    /*
      The property that makes a link something a player can *send*: the same URL in the same browser
      always boots the same way. No preference, no first-run flag, no "remember my choice" — so a
      link that worked when it was pasted works again tomorrow, and a support answer is never "clear
      your settings".
    */
    const context = { search: "?game=abc", apiUrl: API, savedId: null } as const;
    const answers = Array.from({ length: 5 }, () => bootsOnline(context));
    expect(new Set(answers)).toEqual(new Set([true]));
  });
});

describe("savedGameId", () => {
  it("reads the id an ADR-011 save file carries", () => {
    expect(savedGameId(JSON.stringify({ state: { game_id: "g1" } }))).toBe("g1");
  });

  it("still reads a bare state written before ADR-011", () => {
    // Refusing this would throw away the game of every player who had the tab open across a deploy,
    // which is the failure ADR-010 exists to prevent.
    expect(savedGameId(JSON.stringify({ game_id: "g1" }))).toBe("g1");
  });

  it("prefers the save file's own id when a slot carries both", () => {
    expect(savedGameId(JSON.stringify({ game_id: "old", state: { game_id: "new" } }))).toBe("new");
  });

  it("treats anything it cannot read as an empty slot", () => {
    expect(savedGameId(null)).toBeNull();
    expect(savedGameId("")).toBeNull();
    expect(savedGameId("{ half a write")).toBeNull();
    expect(savedGameId(JSON.stringify("a string"))).toBeNull();
    expect(savedGameId(JSON.stringify(null))).toBeNull();
    expect(savedGameId(JSON.stringify({ state: {} }))).toBeNull();
    expect(savedGameId(JSON.stringify({ game_id: "" }))).toBeNull();
    expect(savedGameId(JSON.stringify({ game_id: 7 }))).toBeNull();
  });
});
