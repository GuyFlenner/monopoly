import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initI18n } from "./i18n";
import { isLocalEngineBuild } from "./local/mode";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root is missing from index.html");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Game state arrives by WebSocket, so background refetching would only fight it.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Created here, while `container`'s null check still narrows its type — TypeScript does
// not carry that narrowing into the closure below, since it cannot prove the closure runs
// before `container` could change.
const root = createRoot(container);

// i18n is initialised before the first render so no component ever paints a raw key.
// Wrapped rather than a top-level `await`: the configured build target (see
// vite.config.ts's default browser matrix) predates top-level await support.
async function bootstrap(): Promise<void> {
  // Hebrew, not English. This product's first audience plays in Hebrew — the Israeli board is one of
  // the two shipped boards and the whole of M5 exists to serve that reader — so opening in English
  // and asking them to find a switch is the wrong default for the wrong majority. English is one
  // click away in the same control, on both screens.
  await initI18n("he");

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>{await shell()}</QueryClientProvider>
    </StrictMode>,
  );
}

/**
 * The app, and in the local build the gate that loads a rules engine for it first (MON-805).
 *
 * `import("./local")` is dynamic, so Rollup emits the whole local transport as its own chunk (~9 kB)
 * and a build talking to the HTTP server never requests it — the branch is false, so the fetch never
 * happens, and nothing is preloaded either. The multi-megabyte part, Pyodide itself, is a level
 * further out still: `engine.ts` imports it from a CDN by URL at run time, so it is not in any chunk.
 *
 * `./local/mode` is the one thing imported statically here, and it exists precisely so that asking
 * which build this is does not drag in what it answers about.
 */
async function shell(): Promise<ReactNode> {
  if (!isLocalEngineBuild()) {
    return <App />;
  }
  const { LocalEngineGate, startLocalEngine } = await import("./local");
  return (
    <LocalEngineGate start={startLocalEngine}>
      {(client) => <App client={client} />}
    </LocalEngineGate>
  );
}

void bootstrap();
