/**
 * What must be true of the transport decision (MON-727).
 *
 * One assertion carries this file: **the online branch never asks for the local transport.** Every
 * other test here could pass while a joiner waits for a ~12 MB interpreter they will not use, so the
 * loader is a spy and "was it called" is the property, not "what did it render".
 *
 * The rendering assertions are the cheap half — that each branch produces the right shell — and they
 * exist so a refactor cannot satisfy the loader assertion by never rendering anything at all.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { shell, type LocalTransport } from "./shell";

/**
 * Mount a shell the way `main.tsx` does.
 *
 * The query provider lives in the entry point rather than in `shell`, so a test rendering what
 * `shell` returned has to supply it — the same seam `renderApp` uses in `appHarness`.
 */
function mount(tree: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>);
}

/**
 * A stand-in for `import("./local")`, which reports whether it was ever asked for.
 *
 * The gate is a marker rather than the real component: what is under test is *which* branch ran, and
 * mounting the real gate would start a Pyodide load in a test runner.
 */
function loader() {
  const loadLocal = vi.fn((): Promise<LocalTransport> =>
    Promise.resolve({
      LocalEngineGate: () => <p>local gate</p>,
      startLocalEngine: (() => Promise.resolve()) as unknown as LocalTransport["startLocalEngine"],
    }),
  );
  return loadLocal;
}

describe("a build that was never given a local engine", () => {
  it("mounts the app and asks for nothing else", async () => {
    const loadLocal = loader();
    await shell({ loadLocal, localBuild: false, online: false });
    expect(loadLocal).not.toHaveBeenCalled();
  });
});

describe("the local build", () => {
  it("loads the engine in the tab for an ordinary visit", async () => {
    const loadLocal = loader();
    const tree = await shell({ loadLocal, localBuild: true, online: false });
    expect(loadLocal).toHaveBeenCalledTimes(1);
    mount(tree);
    expect(screen.getByText("local gate")).toBeInTheDocument();
  });

  it("never asks for the local transport when the visit is a shared link", async () => {
    /*
      THE assertion. `import("./local")` is what eventually pulls Pyodide from a CDN, so a shell that
      requested it and then discarded it would cost every joiner ~12 MB to reach a game the API was
      always going to serve. Asserting on the *loader* rather than on the rendered output is what
      makes this a claim about the fetch: a version that loaded the transport and rendered `<App />`
      anyway would look identical on screen and be the whole defect.
    */
    const loadLocal = loader();
    await shell({ loadLocal, localBuild: true, online: true });
    expect(loadLocal).not.toHaveBeenCalled();
  });

  it("mounts the plain app for a shared link, with no gate in front of it", async () => {
    // The other half: not asking for the transport must not mean rendering nothing.
    const loadLocal = loader();
    const tree = await shell({ loadLocal, localBuild: true, online: true });
    mount(tree);
    expect(screen.queryByText("local gate")).not.toBeInTheDocument();
    // `<App />` renders its own loading state against the API rather than the engine gate's.
    expect(screen.queryByTestId("setup-loading")).toBeInTheDocument();
  });
});
