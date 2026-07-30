/**
 * The local transport: an `ApiClient` whose server is the rules engine in this tab (MON-805).
 *
 * `ApiClient` takes its `fetch` and its socket factory as constructor options, so a build with no
 * server is a build that passes two different functions in. Nothing above this directory changes,
 * and nothing above it knows which build it is: `useGame`, `GameProvider`, the event queue, the
 * narration and every panel see the same client, the same `{reason_key, params}` failures and the
 * same `LoggedEvent` frames.
 *
 * Four files, and the split is the interesting part:
 *
 * - `bridge.ts` — the contract with Python, and the envelope parsing. No I/O.
 * - `localFetch.ts` — paths to facade calls, envelopes to `Response`s.
 * - `localSocket.ts` — the event fan-out and the bot pump, behind a `SocketLike`.
 * - `engine.ts` — the only file that knows Pyodide exists.
 *
 * Everything except `engine.ts` is written against an interface, which is why the unit gate can
 * cover the whole transport with a fake bridge and no WebAssembly.
 */

import { ApiClient } from "@/api";

import type { PyBridge } from "./bridge";
import { loadPyodideBridge, type LoadEngineOptions } from "./engine";
import { createLocalFetch } from "./localFetch";
import { createLocalSocketFactory, LocalEventBus } from "./localSocket";

export type { BotStepResult, Envelope, EventBatch, PyBridge } from "./bridge";
export { asBotStep, asEventBatch, MALFORMED_ENVELOPE_STATUS, parseEnvelope } from "./bridge";
export {
  bridgeTo,
  LOAD_STAGES,
  loadPyodideBridge,
  PYODIDE_VERSION,
  PYPI_DEPENDENCIES,
  WHEEL_DIRECTORY,
} from "./engine";
export type { LoadEngineOptions } from "./engine";
export { createLocalFetch, DEFAULT_LOCAL_BASE_PATH } from "./localFetch";
export type { LocalFetchOptions } from "./localFetch";
export {
  createLocalSocketFactory,
  LOCAL_WS_GAME_NOT_FOUND,
  LocalEventBus,
  LocalSocket,
} from "./localSocket";
export { LocalEngineGate } from "./LocalEngineGate";
export type { LocalEngineGateProps } from "./LocalEngineGate";
// Re-exported for completeness; `main.tsx` imports it from `./local/mode` directly, so that asking
// which build this is does not pull the whole local transport into the server build's bundle.
export { isLocalEngineBuild, LOCAL_ENGINE } from "./mode";

/**
 * An `ApiClient` wired to a bridge, with the bot pump attached to the event bus.
 *
 * Split from {@link startLocalEngine} so a test can build the whole transport over a fake bridge —
 * which is what `localTransport.test.ts` does, driving `ApiClient` itself rather than a stand-in.
 */
export function localApiClient(bridge: PyBridge): ApiClient {
  const bus = new LocalEventBus(bridge);
  return new ApiClient({
    fetch: createLocalFetch(bridge, {
      // Fired, not awaited. The caller's own move is already in the response it is waiting for; the
      // bots' moves arrive behind it as socket frames, which is the whole of MON-304 and the reason
      // seating a computer does not turn a click into a three-second pause.
      onMutation: (gameId) => {
        void bus.pump(gameId);
      },
    }),
    createSocket: createLocalSocketFactory(bus),
  });
}

/** Load the engine, then hand back a client talking to it. The app's one entry point here. */
export async function startLocalEngine(options: LoadEngineOptions = {}): Promise<ApiClient> {
  return localApiClient(await loadPyodideBridge(options));
}
