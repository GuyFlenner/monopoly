import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
// vitest/config re-exports vite's defineConfig with the `test` block merged into the
// UserConfig type — importing from "vite" directly makes `test` an unknown property.
import { defineConfig } from "vitest/config";

export default defineConfig({
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
  },
});
