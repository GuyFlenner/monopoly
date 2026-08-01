import { describe, expect, it } from "vitest";

import {
  asBotStep,
  asEventBatch,
  MALFORMED_ENVELOPE_STATUS,
  parseEnvelope,
  type PyBridge,
} from "./bridge";
import { createFakeBridge, envelope } from "./fixtures";
import { isLocalEngineBuild, LOCAL_ENGINE } from "./mode";

/**
 * The envelope parsers, and what they do when handed something that is not one.
 *
 * The failure mode being defended against is specific: the Python side lives behind a WebAssembly
 * runtime fetched from a CDN, so "the call returned `undefined`" is a real state and it must not
 * surface as a `TypeError` thrown from inside a React render. Every parser here answers with
 * something the layer above already knows how to report.
 */
describe("parseEnvelope", () => {
  it("reads the status and body the facade sent", () => {
    expect(parseEnvelope(envelope(201, { state: { game_id: "g1" } }))).toEqual({
      status: 201,
      body: { state: { game_id: "g1" } },
    });
  });

  it("keeps a 204's null body null rather than inventing an empty object", () => {
    expect(parseEnvelope(envelope(204, null))).toEqual({ status: 204, body: null });
  });

  it.each([
    ["not a string at all", undefined],
    ["a call that returned nothing", null],
    ["text that is not JSON", "<!doctype html>"],
    ["JSON that is not an object", "[1, 2, 3]"],
    ["an object with no status", JSON.stringify({ body: {} })],
    ["a status that is not a number", JSON.stringify({ status: "200", body: {} })],
    ["a fractional status", JSON.stringify({ status: 200.5, body: {} })],
  ])("reports %s as a bodiless 500, which the client renders as error.network", (_case, input) => {
    expect(parseEnvelope(input)).toEqual({ status: MALFORMED_ENVELOPE_STATUS, body: null });
  });
});

describe("asEventBatch", () => {
  it("accepts the replay shape the facade sends", () => {
    expect(asEventBatch({ events: [{ seq: 1 }], event_cursor: 1 })).toEqual({
      events: [{ seq: 1 }],
      event_cursor: 1,
    });
  });

  it.each([
    ["a keyed error body", { reason_key: "error.game_not_found", params: {} }],
    ["a missing cursor", { events: [] }],
    ["events that are not a list", { events: {}, event_cursor: 0 }],
    ["null", null],
    ["a string", "events"],
  ])("refuses %s", (_case, body) => {
    expect(asEventBatch(body)).toBeNull();
  });
});

describe("asBotStep", () => {
  it("accepts a step and carries its done flag", () => {
    expect(asBotStep({ done: false, events: [], event_cursor: 3 })).toEqual({
      done: false,
      events: [],
      event_cursor: 3,
    });
  });

  it("refuses a batch with no done flag, because the pump would then never stop", () => {
    expect(asBotStep({ events: [], event_cursor: 3 })).toBeNull();
    expect(asBotStep({ done: "yes", events: [], event_cursor: 3 })).toBeNull();
  });
});

describe("the fake bridge the rest of these tests use", () => {
  it("satisfies PyBridge, so a test cannot drift from the interface the app is wired to", () => {
    // Typed rather than asserted: if `PyBridge` grows a method, this assignment stops compiling and
    // the fixture has to grow too — which is the point of the fake being typed at all.
    const bridge: PyBridge = createFakeBridge();
    expect(typeof bridge.advanceBotsStep).toBe("function");
  });

  it("grows its log two entries per bot step and then reports done", async () => {
    const bridge = createFakeBridge({ botMoves: 2 });
    await bridge.advanceBotsStep("g1");
    await bridge.advanceBotsStep("g1");
    expect(bridge.log).toHaveLength(4);
    expect(parseEnvelope(await bridge.advanceBotsStep("g1")).body).toMatchObject({ done: true });
  });
});

describe("isLocalEngineBuild", () => {
  it("is true for exactly one value and false for everything else", () => {
    expect(isLocalEngineBuild(LOCAL_ENGINE)).toBe(true);
    expect(isLocalEngineBuild("Local")).toBe(false);
    expect(isLocalEngineBuild("server")).toBe(false);
    expect(isLocalEngineBuild(undefined)).toBe(false);
  });
});
