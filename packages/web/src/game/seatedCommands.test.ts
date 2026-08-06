/**
 * What must be true of the one filter between the engine and the bar.
 *
 * This module *narrows what the screen offers*, which is the thing `GameScreen`'s docstring says is
 * worth reverting a release over — so the tests that earn their keep are the ones that hold the
 * narrowing to its stated bounds. Two of them are the whole point: turn flow is never dropped
 * whoever it belongs to, and a human's estate is never dropped either.
 */

import { describe, expect, it } from "vitest";

import type { Command, PlayerView } from "@/api";
import { makePlayer } from "@/test/fixtures";
import { COMMAND_KINDS, zoneOf } from "@/theme";

import { actingFor, isBot, movesAtThisScreen } from "./seatedCommands";

const RUTI: PlayerView = makePlayer(0, { name: "Ruti" });
const DAN: PlayerView = makePlayer(1, { name: "Dan" });
const BOT: PlayerView = makePlayer(2, {
  name: "Robo",
  kind: { bot_level: "normal" },
  is_bot: true,
});

const TABLE: readonly PlayerView[] = [RUTI, DAN, BOT];

/** The position that produced the report: seat 0's turn, and two other seats hold complete groups. */
const LEGAL: readonly Command[] = [
  { kind: "roll_dice", player: 0 },
  { kind: "build_house", player: 0, tile: 1 },
  { kind: "build_house", player: 1, tile: 3 },
  { kind: "build_house", player: 2, tile: 6 },
  { kind: "mortgage_property", player: 2, tile: 8 },
];

describe("isBot", () => {
  it("reads the projection's own answer rather than re-deriving it from the level", () => {
    expect(isBot(RUTI)).toBe(false);
    expect(isBot(BOT)).toBe(true);
  });

  it("believes `is_bot` even when a hand-built seat contradicts itself", () => {
    /*
      Not a case the server can produce — `is_bot` is derived from the level — and that is the point.
      This pins *which field is authoritative*, so a future edit to `player.kind.bot_level !== null`
      goes red instead of passing on every realistic fixture. The engine owns what makes a seat a bot;
      this file owns nothing but the reading of its answer.
    */
    expect(isBot(makePlayer(3, { kind: { bot_level: "hard" }, is_bot: false }))).toBe(false);
    expect(isBot(makePlayer(4, { kind: { bot_level: null }, is_bot: true }))).toBe(true);
  });
});

describe("movesAtThisScreen", () => {
  it("drops a bot's estate moves and keeps every human's", () => {
    expect(movesAtThisScreen(LEGAL, TABLE)).toEqual([
      { kind: "roll_dice", player: 0 },
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "build_house", player: 1, tile: 3 },
    ]);
  });

  it("never drops turn flow, whoever it belongs to", () => {
    /*
      The bound that keeps this a convenience rather than a rule. A bot's `roll_dice` should not reach
      a resting view — `bots.py` advances every seat the engine is waiting on before the response is
      built — but hiding the move a game is waiting on would be unrecoverable, and hiding an estate
      move only costs a convenience. So every `flow` kind survives for a bot seat, asserted over the
      contract's own list rather than a sample.
    */
    const flowKinds = COMMAND_KINDS.filter((kind) => zoneOf(kind) === "flow");
    expect(flowKinds.length, "the flow zone should not be empty").toBeGreaterThan(0);
    for (const kind of flowKinds) {
      const command = { kind, player: BOT.id } as unknown as Command;
      expect(movesAtThisScreen([command], TABLE), `${kind} was dropped for a bot`).toEqual([
        command,
      ]);
    }
  });

  it("keeps every estate kind for a human seat", () => {
    // The other half: the filter is about *who*, never about *what*. A portfolio kind that started
    // being dropped for humans would be MON-204 quietly repealed in the UI.
    const estateKinds = COMMAND_KINDS.filter((kind) => zoneOf(kind) === "portfolio");
    for (const kind of estateKinds) {
      const command = { kind, player: DAN.id } as unknown as Command;
      expect(movesAtThisScreen([command], TABLE), `${kind} was dropped for a human`).toEqual([
        command,
      ]);
    }
  });

  it("hands an all-human table back untouched, by identity", () => {
    // Identity, not equality: the common case must not rebuild the array, or every chit under it
    // re-renders on every frame.
    const humans = [RUTI, DAN];
    expect(movesAtThisScreen(LEGAL, humans)).toBe(LEGAL);
  });

  it("preserves the engine's order among what is left", () => {
    const kept = movesAtThisScreen(LEGAL, TABLE);
    const positions = kept.map((command) => LEGAL.indexOf(command));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // And by identity, so the bar can still mark a hinted command with `===`.
    for (const command of kept) {
      expect(LEGAL).toContain(command);
    }
  });

  it("says nothing at a table with no seats yet", () => {
    expect(movesAtThisScreen([], [])).toEqual([]);
  });
});

describe("actingFor", () => {
  it("names a seat that is not the one being waited on", () => {
    expect(actingFor(TABLE, 0)({ kind: "build_house", player: 1, tile: 3 })).toBe("Dan");
  });

  it("leaves the current player's own moves unlabelled", () => {
    // A label on every row is a label nobody reads, and whose turn it is is already the banner's job.
    expect(actingFor(TABLE, 0)({ kind: "roll_dice", player: 0 })).toBeUndefined();
    expect(actingFor(TABLE, 0)({ kind: "build_house", player: 0, tile: 1 })).toBeUndefined();
  });

  it("follows the turn rather than a seat number", () => {
    const onDansTurn = actingFor(TABLE, 1);
    expect(onDansTurn({ kind: "build_house", player: 1, tile: 3 })).toBeUndefined();
    expect(onDansTurn({ kind: "build_house", player: 0, tile: 1 })).toBe("Ruti");
  });

  it("stays quiet about a seat the projection does not carry", () => {
    // Unreachable while the view is well-formed; an id in that slot would read as part of the
    // square's name, which is worse than saying nothing.
    expect(actingFor(TABLE, 0)({ kind: "build_house", player: 9, tile: 3 })).toBeUndefined();
  });
});
