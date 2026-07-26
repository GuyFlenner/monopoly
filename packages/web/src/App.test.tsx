import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

/**
 * Smoke test for the M0 placeholder shell (GAP §3 F15): proves the loading and error
 * states actually render from the catalogue, and that a successful fetch reaches the
 * board list. The real component tree arrives at MON-403 onward and will replace this.
 */
function renderApp(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the title and the boards fetched from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "classic", name_key: "board.classic.name", tile_count: 40, ownable_count: 28 },
          ]),
      }),
    );

    renderApp();

    expect(screen.getByRole("heading", { name: "Kesef Street" })).toBeInTheDocument();
    expect(await screen.findByText("Classic (Atlantic City)")).toBeInTheDocument();
  });

  it("shows the loading state via label.loading before the boards resolve", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );

    renderApp();

    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });

  it("shows error.network, not the stale gameNotFound copy, when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("Network error. Please try again.");
  });
});
