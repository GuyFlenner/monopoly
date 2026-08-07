/**
 * Loading the rules engine into the browser (MON-805).
 *
 * The only file in this package that knows Pyodide exists. Everything else in `src/local` is
 * written against {@link PyBridge}, so the route table, the error mapping and the bot pump are all
 * unit-testable against a fake and the WebAssembly runtime stays out of the fast gate.
 *
 * ## What gets installed, and why the dependency resolver is switched off
 *
 * Pyodide already ships `pydantic`, `pydantic-core`, `annotated-types` and `typing-extensions` as
 * WebAssembly builds, so the engine's one dependency needs nothing from us. What has to be added is:
 *
 * 1. **`structlog` and `pydantic-settings`**, from PyPI, with dependency resolution on. Both are
 *    pure Python, as is everything they pull in (`python-dotenv`, `typing-inspection`).
 * 2. **The two wheels of this repository**, with `deps=False`.
 *
 * That `deps=False` is not an optimisation and it is not laziness. `kesef-server`'s metadata
 * declares `fastapi` and `uvicorn[standard]`, and `uvicorn[standard]` pulls `httptools`, `uvloop`
 * and `watchfiles` — native extensions with no pure-Python wheel and therefore nothing micropip can
 * install into WebAssembly. Nothing on `kesef_server.browser`'s import path touches any of them,
 * which is asserted in Python rather than assumed here:
 * `packages/server/tests/test_browser_parity.py::test_the_browser_transport_imports_no_web_framework`
 * imports the module in a subprocess and fails if FastAPI, starlette, anyio or uvicorn appears in
 * `sys.modules`. So the correct install is "these two wheels and nothing they claim to need", plus
 * the four packages listed by hand above — and if that list ever goes stale, the failure is a Python
 * `ImportError` in the console on the first load, not a subtly wrong game.
 *
 * ## Where the wheels come from
 *
 * `.github/workflows/deploy-pages.yml` builds them into `public/wheels/` and writes a
 * `manifest.json` beside them, so the filenames carry the version and nothing here has to be edited
 * when one is bumped. All three URLs are resolved against `import.meta.env.BASE_URL`, which is what
 * lets the same build serve from `/` locally and from `/monopoly/` on GitHub Pages.
 */

import type { PyBridge } from "./bridge";

/**
 * The Pyodide release to load. Pinned, not floating.
 *
 * 0.29.4 ships **CPython 3.13.2** and pydantic 2.12.5. The interpreter version is the constraint
 * that matters: both wheels declare `requires-python = ">=3.13"` and micropip refuses a wheel whose
 * `Requires-Python` the runtime does not satisfy, so an older Pyodide (0.28 and below shipped 3.12)
 * fails at install time with a message about the interpreter and not about this code.
 *
 * A floating "latest" would make the game's rules depend on what a CDN served this morning, which
 * for a deterministic engine is the one dependency style worth refusing outright.
 */
export const PYODIDE_VERSION = "0.29.4";

/** The pure-Python packages Pyodide does not ship. See the module docstring on `deps=False`. */
export const PYPI_DEPENDENCIES: readonly string[] = ["structlog", "pydantic-settings"];

/** Where the built wheels and their manifest live, relative to the site's base. */
export const WHEEL_DIRECTORY = "wheels/";

export interface LoadEngineOptions {
  /** Overridden in a test; in the app it is `import.meta.env.BASE_URL`. */
  readonly baseUrl?: string;
  readonly pyodideVersion?: string;
  /** Progress, for the loading screen. Called with an i18n key, never with prose. */
  readonly onProgress?: (stageKey: string) => void;
}

/** The stages a load goes through, as catalogue keys the loading screen renders. */
export const LOAD_STAGES = {
  runtime: "engine.stage.runtime",
  dependencies: "engine.stage.dependencies",
  rules: "engine.stage.rules",
} as const;

// --- The shapes this file borrows from Pyodide -------------------------------
//
// Declared by hand rather than by adding `pyodide` to package.json: the runtime is loaded from a
// CDN at run time and never bundled, so a build-time dependency would exist only to describe four
// method signatures. These are the four.

interface PyodideKwargsCallable<A extends unknown[], K, R> {
  (...args: A): R;
  callKwargs(...argsAndKwargs: [...A, K]): R;
}

interface Micropip {
  readonly install: PyodideKwargsCallable<[readonly string[]], { deps: boolean }, Promise<void>>;
}

interface PyodideRuntime {
  loadPackage(names: readonly string[]): Promise<unknown>;
  pyimport(name: string): unknown;
}

interface PyodideLoader {
  loadPyodide(options: { indexURL: string }): Promise<PyodideRuntime>;
}

/** `kesef_server.browser`'s public surface, as Pyodide proxies it. */
interface BrowserFacade {
  list_boards(): string;
  list_rulesets(): string;
  create_game(requestJson: string): string;
  // Optional on this side too, because that is how "not given" crosses into Python — see `bridgeTo`.
  load_game(saveJson: string, ifExists?: string): string;
  get_game(gameId: string, since?: string): string;
  save_game(gameId: string): string;
  submit_command(gameId: string, requestJson: string): string;
  validate_command(gameId: string, requestJson: string): string;
  delete_game(gameId: string): string;
  events_since(gameId: string, cursor: number): string;
  advance_bots_step(gameId: string): Promise<string>;
}

// --- Loading ----------------------------------------------------------------

/**
 * Bring up the engine and return the bridge to it.
 *
 * Resolves once `kesef_server.browser` is importable, which is the first moment a game can be
 * created. The caller renders a loading state until then — the wheels and the interpreter are a few
 * megabytes, and a blank screen for that long looks like a broken deployment.
 */
export async function loadPyodideBridge(options: LoadEngineOptions = {}): Promise<PyBridge> {
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
  const version = options.pyodideVersion ?? import.meta.env.VITE_PYODIDE_VERSION ?? PYODIDE_VERSION;
  const indexURL = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

  options.onProgress?.(LOAD_STAGES.runtime);
  // A runtime-computed specifier, so Vite must not try to resolve it at build time: the module is
  // fetched from the CDN by the browser, and bundling a WebAssembly loader is not the intent.
  const loader = (await import(
    /* @vite-ignore */ `${indexURL}pyodide.mjs`
  )) as unknown as PyodideLoader;
  const pyodide = await loader.loadPyodide({ indexURL });

  options.onProgress?.(LOAD_STAGES.dependencies);
  await pyodide.loadPackage(["micropip", "pydantic"]);
  const micropip = pyodide.pyimport("micropip") as Micropip;
  await micropip.install(PYPI_DEPENDENCIES);

  options.onProgress?.(LOAD_STAGES.rules);
  await micropip.install.callKwargs(await wheelUrls(baseUrl), { deps: false });
  const facade = pyodide.pyimport("kesef_server.browser") as BrowserFacade;
  return bridgeTo(facade);
}

/**
 * The wheels to install, read from the manifest the deploy workflow writes.
 *
 * A manifest rather than two hardcoded filenames, because a wheel's name carries its version and a
 * version bump would otherwise be a silent 404 at load time — the sort of breakage that only shows
 * up in production, since a local build has whichever wheels the developer last built.
 */
async function wheelUrls(baseUrl: string): Promise<string[]> {
  const directory = new URL(WHEEL_DIRECTORY, absolute(baseUrl));
  const response = await fetch(new URL("manifest.json", directory));
  if (!response.ok) {
    throw new Error(
      `no wheel manifest at ${directory.toString()} (HTTP ${String(response.status)})`,
    );
  }
  const listed: unknown = await response.json();
  if (!Array.isArray(listed) || listed.some((name) => typeof name !== "string")) {
    throw new Error(`the wheel manifest at ${directory.toString()} is not a list of filenames`);
  }
  return (listed as string[]).map((name) => new URL(name, directory).toString());
}

/** `BASE_URL` is a path (`/` or `/monopoly/`); a `URL` needs an origin to resolve against. */
function absolute(baseUrl: string): string {
  return new URL(baseUrl, globalThis.location.href).toString();
}

/**
 * Wrap the Python module in the bridge the rest of this package is written against.
 *
 * Every method is `snake_case` on one side and `camelCase` on the other, and that is the entire
 * translation: no argument is reshaped, no answer is parsed. The parsing lives in `bridge.ts`, at
 * the point of use, so a malformed answer is handled once rather than at twelve call sites.
 */
export function bridgeTo(facade: BrowserFacade): PyBridge {
  return {
    listBoards: () => Promise.resolve(facade.list_boards()),
    listRulesets: () => Promise.resolve(facade.list_rulesets()),
    createGame: (requestJson) => Promise.resolve(facade.create_game(requestJson)),
    /*
      An absent optional parameter is *omitted*, never passed as `null`.

      Pyodide stopped translating JS `null` to Python `None`: since 0.28 it arrives as a distinct
      `JsNull`, so `raw is None` is false for it and `int(raw)` or `IfExists(raw)` fails on an object
      the Python side has no reason to expect. Measured on the built artifact, that turned a restored
      game into `422 error.malformed_request` and a reload back into the game-losing bug ADR-010 fixed
      — `null` for `if_exists` was read as a *typo* rather than as "not given". The same hazard is on
      `since`, where the value is `URLSearchParams.get`'s own `null` for an omitted query parameter.

      Omitting the argument lets Python's own default apply, which is the only spelling of "absent"
      that both languages agree on. `??` would not do: `undefined` is a JS value too, and relying on
      its conversion is relying on the same table that has already changed once.
    */
    loadGame: (saveJson, ifExists) =>
      Promise.resolve(
        ifExists === null ? facade.load_game(saveJson) : facade.load_game(saveJson, ifExists),
      ),
    getGame: (gameId, since) =>
      Promise.resolve(since === null ? facade.get_game(gameId) : facade.get_game(gameId, since)),
    saveGame: (gameId) => Promise.resolve(facade.save_game(gameId)),
    submitCommand: (gameId, requestJson) =>
      Promise.resolve(facade.submit_command(gameId, requestJson)),
    validateCommand: (gameId, requestJson) =>
      Promise.resolve(facade.validate_command(gameId, requestJson)),
    deleteGame: (gameId) => Promise.resolve(facade.delete_game(gameId)),
    eventsSince: (gameId, cursor) => Promise.resolve(facade.events_since(gameId, cursor)),
    // The one genuinely asynchronous call: it awaits `Settings.bot_think_seconds` inside Python, so
    // the pause happens where the setting lives and this side has no timer of its own.
    advanceBotsStep: (gameId) => facade.advance_bots_step(gameId),
  };
}
