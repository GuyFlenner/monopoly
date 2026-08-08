import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
// vitest/config re-exports vite's defineConfig with the `test` block merged into the
// UserConfig type — importing from "vite" directly makes `test` an unknown property.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Where the site is served from. `/` for a dev server and for a domain root; `/monopoly/` for
  // GitHub Pages, which serves a project site under the repository's name (MON-805). Every asset
  // URL — including the Pyodide wheels, which are fetched at run time and so cannot be rewritten by
  // the bundler — resolves against `import.meta.env.BASE_URL`, which is this value.
  base: process.env["VITE_BASE"] ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    // The API is same-origin in production; the proxy makes it same-origin in dev too,
    // so no CORS-only code paths exist that production never exercises.
    //
    // The target is the *only* place the API's address is configurable, because the client
    // itself only ever asks for `/api` (see `api/client.ts`'s `DEFAULT_BASE_URL`). `KESEF_API_URL`
    // exists so that a second server on another port — a scratch run, two branches side by
    // side — can be driven without editing this file.
    proxy: {
      "/api": {
        target: process.env["KESEF_API_URL"] ?? "http://127.0.0.1:8000",
        changeOrigin: true,
        // The event stream is a WebSocket under the same prefix, and a proxy without this
        // refuses the upgrade — which in dev looked exactly like a server that never pushes:
        // commands still worked (the response *is* the new view), so the only symptom was a
        // permanent "reconnecting" note and a log that never moved on its own.
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // Vitest owns `src`, Playwright owns `e2e` (MON-502). Stated rather than left to the default
    // glob, which matches `**/*.spec.ts` and therefore swept up the Playwright specs the moment they
    // existed — they import `@playwright/test`, so they fail to collect under a jsdom runner and the
    // suite went red for a reason that had nothing to do with the code.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // MON-731: v8 coverage instruments every module the test imports, and the heaviest tests here
    // (the axe scans, the debounced trade-review panel) were already close enough to the 5 s default
    // that the instrumentation overhead alone pushed thirteen of them over it — none of them became
    // slower in wall-clock terms than a person would notice, they became slower than the default. A
    // single global bump rather than per-file overrides, because the cause is global (every test pays
    // the same instrumentation tax) and a per-file timeout is the kind of thing that goes stale the
    // next time a fast test picks up one more `await`.
    testTimeout: 15_000,
    // MON-731: the Python side has had a coverage floor since MON-209 (`pyproject.toml`'s
    // `fail_under = 90`); the web package had none — `npm run test -- --run --coverage` could not
    // even report a number. `v8` rather than `istanbul`: no extra instrumentation dependency, and
    // it is what Node already collects.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        "src/**/*.d.ts",
        "src/api/generated.ts", // openapi-typescript output — nothing here is hand-written or tested
      ],
      // Each floor below is the measured TOTAL (`npm run test -- --run --coverage`) rounded down
      // and then given one further point of slack, for the same reason `pyproject.toml`'s
      // `fail_under = 90` comment gives for its own floor: room for ordinary branch-coverage noise
      // rather than a gate pinned to today's exact number. Four figures because v8 reports branches
      // separately from statements, and a coverage regression can hide in either.
      //
      // MON-750 re-measured them under vitest 4. `@vitest/coverage-v8` 4 remaps V8's raw byte
      // ranges through the AST (`ast-v8-to-istanbul`, opt-in as `experimentalAstAwareRemapping` in
      // vitest 3, the only behaviour in 4), so the same tests over the same code report different
      // figures — the measurement changed, the coverage did not:
      //
      //     metric      vitest 2   vitest 4
      //     statements     95.38      93.69
      //     branches       89.65      89.40
      //     functions      91.06      92.41
      //     lines          95.38      94.10
      //
      // Statements and lines were identical under 2 because raw V8 output cannot tell them apart;
      // 4 counts them separately. Functions rose because 2 charged every module with an uncovered
      // line 1 — that phantom is gone from the per-file reports here. The floors are re-derived
      // from the right-hand column by the same round-down-then-one rule, not lowered to fit;
      // consecutive runs of the unchanged suite land within about a tenth of a point of those
      // figures, which is the noise the point of slack is there to absorb.
      thresholds: {
        statements: 92,
        branches: 88,
        functions: 91,
        lines: 93,
      },
    },
  },
});
