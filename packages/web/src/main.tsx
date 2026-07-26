import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initI18n } from "./i18n";
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
  await initI18n("en");

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
