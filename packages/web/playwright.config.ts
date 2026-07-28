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
 */

import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const WEB_PORT = 5173;
const API_PORT = 8000;
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
