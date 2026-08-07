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
  it("keeps only the seat-in-play's estate, and every other seat's is gone", () => {
    // The owner's report, 2026-08-07: with two players each holding a complete group, both sets of
    // streets were on the bar. A name against a row turned out to be a weaker signal than the row not
    // being there.
    expect(movesAtThisScreen(LEGAL, TABLE, RUTI.id)).toEqual([
      { kind: "roll_dice", player: 0 },
      { kind: "build_house", player: 0, tile: 1 },
    ]);
  });

  it("follows the turn rather than a seat number", () => {
    // The same legal set, one turn later. Nothing is keyed on "seat 0"; it is keyed on who is in play.
    expect(movesAtThisScreen(LEGAL, TABLE, DAN.id)).toEqual([
      { kind: "roll_dice", player: 0 },
      { kind: "build_house", player: 1, tile: 3 },
    ]);
  });

  it("offers no estate at all while a bot is the seat in play", () => {
    /*
      Reachable: a bot that proposes a trade to a human leaves the game in `TRADE_REVIEW` with the bot
      still current (`bots.py` on the one-proposal-per-turn rule). It is nobody's turn to build, so the
      answer is nothing rather than the bot's own streets.
    */
    expect(movesAtThisScreen(LEGAL, TABLE, BOT.id)).toEqual([{ kind: "roll_dice", player: 0 }]);
  });

  it("never drops turn flow, whoever it belongs to", () => {
    /*
      The bound that keeps this a convenience rather than a rule, and it matters more since MON-753
      than it did before: the interrupt phases exist *for* a seat whose turn it is not — a bidder, a
      debtor, the two sides of a trade — so "not the current player" is a perfectly ordinary thing for
      a flow command to be. Hiding the move a game is waiting on would be unrecoverable; hiding an
      estate move only costs a convenience. Asserted over the contract's own list, not a sample.
    */
    const flowKinds = COMMAND_KINDS.filter((kind) => zoneOf(kind) === "flow");
    expect(flowKinds.length, "the flow zone should not be empty").toBeGreaterThan(0);
    for (const kind of flowKinds) {
      const command = { kind, player: DAN.id } as unknown as Command;
      // Asked while it is *not* Dan's turn, which is the case that would strand a game.
      expect(
        movesAtThisScreen([command], TABLE, RUTI.id),
        `${kind} was dropped for a seat that is not in play`,
      ).toEqual([command]);
    }
  });

  it("keeps every estate kind for the seat in play", () => {
    // The other half: the filter is about *whose turn it is*, never about *what the move is*. A
    // portfolio kind that started being dropped for the current player would be a different defect.
    const estateKinds = COMMAND_KINDS.filter((kind) => zoneOf(kind) === "portfolio");
    expect(estateKinds.length, "the portfolio zone should not be empty").toBeGreaterThan(0);
    for (const kind of estateKinds) {
      const command = { kind, player: DAN.id } as unknown as Command;
      expect(
        movesAtThisScreen([command], TABLE, DAN.id),
        `${kind} was dropped for the seat in play`,
      ).toEqual([command]);
    }
  });

  it("preserves the engine's order, and the objects themselves", () => {
    const kept = movesAtThisScreen(LEGAL, TABLE, RUTI.id);
    const positions = kept.map((command) => LEGAL.indexOf(command));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // By identity, so the bar can still mark a hinted command with `===`.
    for (const command of kept) {
      expect(LEGAL).toContain(command);
    }
  });

  it("says nothing at a table with no seats yet", () => {
    expect(movesAtThisScreen([], [], -1)).toEqual([]);
  });

  it("offers no estate for a seat the projection does not carry", () => {
    // Unreachable while the view is well-formed. Answering "nothing" is the safe way to be wrong:
    // the alternative offers somebody's streets on nobody's turn.
    expect(movesAtThisScreen(LEGAL, TABLE, 99)).toEqual([{ kind: "roll_dice", player: 0 }]);
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
