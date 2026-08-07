/**
 * The e2e surface — the one gate with a layout engine behind it.
 *
 * ## Why this exists, in one paragraph
 *
 * M4 shipped a board that overflowed its container **at every viewport width**: at 320 px the grid's
 * box was 295 × 295 and its `scrollHeight` was 414, so eleven rows of squares painted a hundred and
 * twenty pixels below the felt and over the panels. Six hundred and forty-six passing Vitest tests
 * never saw it, because **jsdom has no layout engine** — `scrollHeight` is 0 for every element in
 * every one of them. `src/board/board.css.test.ts` says so in its own docstring and names the
 * assertion that belongs here. This config is that assertion's home.
 *
 * MON-707 scheduled this surface last, in M7. It is being stood up now, with MON-502, because the
 * RTL audit's central claim — that the board does *not* mirror — is a geometric claim, and the only
 * way to check it is to measure two renders.
 *
 * ## Two servers, not a mock
 *
 * The Vitest suite already covers this app against a fake edge. Repeating that here would be slower
 * and prove less, so these tests drive the **real** stack: uvicorn serving the engine, and Vite
 * proxying `/api` to it exactly as a developer's browser does. A layout bug and a proxy bug are both
 * in scope; neither is visible to a fake.
 *
 * `reuseExistingServer` is on outside CI so a developer with both already running pays nothing.
 *
 * ## The ports are overridable, and that is a correctness matter rather than a convenience
 *
 * `reuseExistingServer` plus a hardcoded port is a quiet way to test the wrong code. A second
 * checkout of this repo — a worktree, a colleague's branch, an agent working in parallel — with a dev
 * server already on 5173 will be **silently reused**, so the suite reports on that tree's build while
 * appearing to report on this one. It is not a hypothetical: it happened during MON-708, and the pass
 * it would have produced was worthless.
 *
 * So `KESEF_E2E_WEB_PORT` and `KESEF_E2E_API_PORT` exist, alongside the `KESEF_API_URL` that
 * `vite.config.ts` already honours for the same reason. Running a second tree's e2e is:
 *
 * ```
 * KESEF_E2E_WEB_PORT=5199 KESEF_E2E_API_PORT=8099 \
 *   KESEF_API_URL=http://127.0.0.1:8099 npx playwright test
 * ```
 *
 * `KESEF_API_URL` has to be set too, because the *proxy target* is Vite's to know, not this file's.
 * CI leaves all three unset and keeps the defaults, where `reuseExistingServer` is off anyway.
 */

import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";

/** A port from the environment, or the default. A non-numeric value is a typo, not a port. */
function port(variable: string, fallback: number): number {
  const raw = process.env[variable];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

const WEB_PORT = port("KESEF_E2E_WEB_PORT", 5173);
const API_PORT = port("KESEF_E2E_API_PORT", 8000);
const isCI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "./e2e",
  // A layout assertion that "passes on the second go" is a layout assertion nobody can trust, so
  // there is no retry budget for flake to hide in. A real failure here is deterministic.
  retries: 0,
  fullyParallel: false,
  forbidOnly: isCI,
  reporter: isCI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://${HOST}:${String(WEB_PORT)}`,
    trace: isCI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },

  // One browser. The bugs this surface exists to catch are this application's layout and this
  // application's transport, not a rendering difference between engines — and a matrix would treble
  // the slowest job in CI to re-answer a question Vitest already asks per component.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      // `uv run` from the repository root, two levels up from this package.
      command: `uv run uvicorn kesef_server.api:app --host ${HOST} --port ${String(API_PORT)}`,
      cwd: "../..",
      /*
       * A bigger session cap for the test server, and this is a correctness matter rather than tuning
       * (MON-707).
       *
       * `Settings.max_sessions` defaults to **50** and `session_ttl_minutes` to **240**, so nothing a
       * suite creates is reclaimed while the suite is running. Every `startGame` takes a slot, and this
       * directory is past forty of them — so the suite was one spec away from filling the store, at
       * which point `POST /games` starts answering `error.server_at_capacity` and *every remaining test
       * fails on a missing board*. It is not hypothetical: it happened while MON-707 was being written,
       * against a dev server that had been reused across several runs, and the failure looks exactly
       * like a broken setup screen.
       *
       * Raised here rather than in `config.py`, because 50 is the right default for a process serving
       * families and the wrong one for a test run that starts a fresh game per assertion. `env` rather
       * than a `VAR=value` prefix on the command, because that prefix is POSIX shell syntax and this
       * config also runs on Windows.
       */
      /*
       * MON-905 added per-client limits, and to this suite a "client" is one address: every spec
       * arrives from 127.0.0.1, so the defaults (30 mutating requests a minute, 5 games per client)
       * refuse the forty-plus games this directory starts for the same reason the 50-session store
       * did above. Raised here and not in `config.py`, for the same reason as the line above it.
       */
      env: {
        KESEF_MAX_SESSIONS: "400",
        KESEF_MAX_SESSIONS_PER_CLIENT: "400",
        KESEF_REQUESTS_PER_MINUTE: "10000",
      },
      url: `http://${HOST}:${String(API_PORT)}/boards`,
      reuseExistingServer: !isCI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      command: `npm run dev -- --host ${HOST} --port ${String(WEB_PORT)} --strictPort`,
      url: `http://${HOST}:${String(WEB_PORT)}`,
      reuseExistingServer: !isCI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  ],
});
