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

// i18n is initialised before the first render so no component ever paints a raw key.
await initI18n("en");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
