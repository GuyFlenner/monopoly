/**
 * Which transport the app is mounted on, decided once, before anything renders.
 *
 * Extracted from `main.tsx` (MON-727) so the one property worth guarding can be asserted rather than
 * argued: **the online branch returns before the local transport is imported.** That is not a
 * performance nicety. `import("./local")` is what eventually pulls Pyodide from a CDN, so a shell
 * that asked for it and then discarded it would cost every joiner ~12 MB to reach a game the API was
 * always going to serve. The branch order *is* the feature, and a refactor that hoists the import
 * above the check would keep every other test in this package green.
 *
 * `main.tsx` keeps the side effects — the root, the query client, i18n — because those are what make
 * an entry point untestable. What is here is a pure decision returning an element.
 *
 * ## The three cases
 *
 * | Build | Visit | Transport |
 * |---|---|---|
 * | server (`VITE_ENGINE` unset) | any | the API, as it always was |
 * | local | a fresh visit, or a reload of this browser's own game | the engine in the tab (MON-805) |
 * | local | a `?game=` link to a game this browser cannot hold | the API (MON-727) |
 *
 * The third row is the new one and `local/mode.ts` holds its argument: one slot means one local
 * game, so an id that is not in it is somebody else's link and the local engine could only ever
 * answer "no such game" — after making them wait for the interpreter to say it.
 */

import type { ReactNode } from "react";

import { App } from "./App";
// `import type` and not `import`: types are erased, so this names the transport's shape without
// putting it in the graph. A value import here would defeat the entire point of the file.
import type { LocalEngineGate, startLocalEngine } from "./local";
import { bootsOnline, isLocalEngineBuild } from "./local/mode";

/** What `import("./local")` resolves to — the two things this file needs from it. */
export interface LocalTransport {
  readonly LocalEngineGate: typeof LocalEngineGate;
  readonly startLocalEngine: typeof startLocalEngine;
}

export interface ShellOptions {
  /**
   * How to fetch the local transport. `() => import("./local")` in the app.
   *
   * A parameter rather than a direct call so a test can assert it was **not** called, which is the
   * whole point of this module. Dynamic either way: the `import()` still lives at the call site in
   * `main.tsx`, so Rollup still emits the transport as its own chunk.
   */
  readonly loadLocal: () => Promise<LocalTransport>;
  /** Defaults to reading `VITE_ENGINE`. */
  readonly localBuild?: boolean;
  /** Defaults to {@link bootsOnline}, which reads the URL, the build and the save slot. */
  readonly online?: boolean;
}

export async function shell({
  loadLocal,
  localBuild = isLocalEngineBuild(),
  online = bootsOnline(),
}: ShellOptions): Promise<ReactNode> {
  // Both branches return `<App />` with no client, which is the same-origin/`VITE_API_URL` default.
  // The order is load-bearing: `loadLocal` must not be reached on the online path.
  if (!localBuild || online) {
    return <App />;
  }
  const { LocalEngineGate, startLocalEngine } = await loadLocal();
  return (
    <LocalEngineGate start={startLocalEngine}>
      {(client) => <App client={client} />}
    </LocalEngineGate>
  );
}
