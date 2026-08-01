/**
 * The post-build smoke surface: the static site, served as a static site (MON-805).
 *
 * Deliberately not part of `playwright.config.ts`. That one drives a dev server and a uvicorn
 * process and measures layout in seconds; this one needs `vite build` to have run, downloads a
 * CPython build from a CDN, and answers a different question — "does the artifact we are about to
 * publish work at all". Two questions, two configs, and `npx playwright test` still means the fast
 * one.
 *
 * `vite preview` rather than a dev server, because the dev server is not what gets deployed: it
 * transforms modules on demand and serves `public/` from source. A wheel that failed to be copied
 * into `dist/`, or a base path that only works when every URL is root-relative, is invisible in dev
 * and fatal on Pages.
 *
 * Run it with `npm run test:e2e:pages`, after `npm run build` and after the wheels are in
 * `public/wheels/` — see docs/DEPLOYMENT.md for the three commands.
 */

import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = 4173;
const isCI = Boolean(process.env["CI"]);

/**
 * The path the built site is served under, which must match the `VITE_BASE` it was built with.
 * `vite preview` reads the base out of the config itself, so this only has to agree with it.
 */
const BASE_PATH = process.env["VITE_BASE"] ?? "/";

export default defineConfig({
  testDir: "./e2e-pages",
  // No retries. A load that "works on the second attempt" is a load a player experiences as broken,
  // and the CDN fetch is the thing most likely to be flaky — which is exactly what should be visible.
  retries: 0,
  fullyParallel: false,
  forbidOnly: isCI,
  reporter: isCI ? [["github"], ["list"]] : [["list"]],
  // Minutes, not seconds: a cold CDN cache is a real first-visit experience.
  timeout: 240_000,
  expect: { timeout: 60_000 },

  use: {
    baseURL: `http://${HOST}:${String(PORT)}${BASE_PATH}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: `npx vite preview --host ${HOST} --port ${String(PORT)} --strictPort`,
    url: `http://${HOST}:${String(PORT)}${BASE_PATH}`,
    // Never reused, unlike `playwright.config.ts`, and the reason is this surface's whole subject.
    // A leftover `vite preview` serving a *differently based* build answers 200 at this URL — vite
    // falls back to `index.html` — so Playwright adopts it, the page asks for `/monopoly/assets/…`
    // against a server rooted at `/`, and every asset 404s into a blank page. That cost half an
    // hour once. A developer with a server already up pays four seconds; a developer debugging a
    // blank page pays much more.
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
});
