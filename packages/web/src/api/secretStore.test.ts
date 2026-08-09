/**
 * The slot a seat credential lives in (ADR-012, MON-906).
 *
 * Small, and worth its own file for one reason: **every failure here is silent**. A store that
 * throws takes a working game down with it; a store that returns the wrong game's secret hands one
 * table's credential to another's server; a store that quietly keeps nothing turns the host into a
 * spectator after a reload. None of the three produces an error a player could report.
 */

import { describe, expect, it, vi } from "vitest";

import {
  browserSecretStore,
  memorySecretStore,
  SECRET_KEY_PREFIX,
  secretKey,
  type StorageLike,
} from "./secretStore";

/** A `Storage` whose every method throws — private mode, as a browser actually behaves. */
function hostileStorage(): StorageLike {
  const refuse = (): never => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

function fakeStorage(): StorageLike & { readonly held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

describe("the secret store", () => {
  it("namespaces its keys under the app's shared prefix (finding 10)", () => {
    // Every key this app writes is `kesef-street:*` (the reload slot, the preferences). A credential
    // under a *different* prefix would be a stranded key no cleanup ever swept — orphaned the day the
    // naming convention was next tidied. Asserted on the literal so a rename that re-strands them fails.
    expect(SECRET_KEY_PREFIX).toBe("kesef-street:secret:");
    expect(secretKey("g1")).toBe("kesef-street:secret:g1");
  });

  it("keeps one slot per game, so two games cannot share a credential", () => {
    // A single shared slot would hand the second game's request the first game's secret, which
    // resolves to Spectator and looks exactly like "the server forgot me".
    const storage = fakeStorage();
    const store = browserSecretStore(storage);

    store.set("g1", "one");
    store.set("g2", "two");

    expect(store.get("g1")).toBe("one");
    expect(store.get("g2")).toBe("two");
    expect([...storage.held.keys()]).toEqual([secretKey("g1"), secretKey("g2")]);
  });

  it("answers undefined for a game it has never been told about", () => {
    expect(browserSecretStore(fakeStorage()).get("nobody")).toBeUndefined();
  });

  it("forgets a game on request", () => {
    const store = browserSecretStore(fakeStorage());
    store.set("g1", "one");

    store.clear("g1");

    expect(store.get("g1")).toBeUndefined();
  });

  it("survives a browser that refuses storage entirely", () => {
    // Private mode throws on *access*, not only on write. A game that is working must not stop
    // working because it could not be written down — ADR-010's discipline, and the same reasoning.
    const store = browserSecretStore(hostileStorage());

    expect(() => {
      store.set("g1", "one");
    }).not.toThrow();
    expect(store.get("g1")).toBeUndefined();
    expect(() => {
      store.clear("g1");
    }).not.toThrow();
  });

  it("survives a browser with no localStorage at all", () => {
    // `globalThis.localStorage` can throw on the property access itself. Reaching for it lazily and
    // catching there is what keeps a non-browser context — a server render, a worker — working.
    const spy = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
      throw new Error("no storage in this context");
    });
    try {
      const store = browserSecretStore();
      expect(store.get("g1")).toBeUndefined();
      expect(() => {
        store.set("g1", "one");
      }).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("has an in-memory twin with the same three behaviours", () => {
    // Used wherever the storage is not the thing under test, so it has to behave identically or the
    // tests that use it are testing something else.
    const store = memorySecretStore();

    expect(store.get("g1")).toBeUndefined();
    store.set("g1", "one");
    expect(store.get("g1")).toBe("one");
    store.clear("g1");
    expect(store.get("g1")).toBeUndefined();
  });
});
