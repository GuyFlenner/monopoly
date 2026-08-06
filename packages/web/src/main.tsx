import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initI18n } from "./i18n";
// `() => import("./local")` stays *here*, at the entry point, so Rollup still emits the whole local
// transport as its own chunk that a server build never requests. `shell` only decides whether to
// call it — see that file for why the branch order is the feature (MON-727).
import { shell } from "./shell";
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
      <QueryClientProvider client={queryClient}>
        {await shell({ loadLocal: () => import("./local") })}
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
