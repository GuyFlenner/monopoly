/**
 * The mounted app, with a fake edge — shared by `App.test.tsx` and the a11y sweep.
 *
 * This was `App.test.tsx`'s private scaffolding until MON-703 needed a second caller. The audit's
 * central claim is "axe clean on every screen and state", and a screen is a *composition*: the
 * setup form inside its `<main>`, the game screen inside the Announcer and the `<ThemeSprite>`
 * whose `<defs>` every band's `url(#…)` resolves against. A fragment rendered on its own answers a
 * different, easier question — which is exactly why `test/axe.ts` has to disable the `region` rule
 * for component tests and why the sweep in `a11y/screens.axe.test.tsx` does not.
 *
 * So the harness moved here rather than being copied. Two fake edges would drift, and the one that
 * drifted would be the audit's — a sweep whose fixtures no longer look like the app's is a sweep
 * that reports on nothing.
 *
 * The fakes go in **at the edge** — a `fetch` and a socket factory handed to a real `ApiClient` — so
 * every caller drives the real client, the real query cache and the real event queue. Nothing here
 * mocks a module.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";

import { App } from "@/App";
import {
  ApiClient,
  type BoardSummary,
  type Command,
  type FetchLike,
  type GameStateView,
  type GameView,
  type LoggedEvent,
  type RulesetView,
  type SocketLike,
} from "@/api";
import { makeRingBoard, makeRingState } from "@/board/fixtures";
import { KIDS_VIEW, UNIVERSAL_VIEW } from "@/panels/SetupScreenFixtures";

import { loggedEvent, makeView } from "./fixtures";

// --- The fake edge ----------------------------------------------------------

/** The sockets the app opened, so a test can drop one. */
export const sockets: FakeSocket[] = [];

export class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

export function ok(body: unknown): Reply {
  return { status: 200, body };
}

export function refusal(
  status: number,
  reasonKey: string,
  params: Record<string, string | number> = {},
): Reply {
  return { status, body: { reason_key: reasonKey, params } };
}

/** `Method /path` (query stripped) -> reply. A request with no route is a test bug, and says so. */
export type Routes = Readonly<Record<string, Reply>>;

export interface Edge {
  readonly client: ApiClient;
  readonly calls: { method: string; path: string; body: unknown }[];
}

export function makeEdge(routes: Routes, options: { readonly hang?: boolean } = {}): Edge {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const doFetch: FetchLike = (input, init) => {
    const method = init?.method ?? "GET";
    const path = input.split("?")[0] ?? input;
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (options.hang === true) {
      return new Promise<Response>(() => undefined);
    }
    const reply = routes[`${method} ${path}`];
    if (reply === undefined) {
      return Promise.reject(new Error(`no route for ${method} ${path}`));
    }
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    } as unknown as Response);
  };

  return {
    calls,
    client: new ApiClient({
      baseUrl: "/api",
      fetch: doFetch,
      createSocket: (url) => new FakeSocket(url),
      origin: "http://localhost/",
    }),
  };
}

// --- Fixtures ---------------------------------------------------------------

export const BOARDS: readonly BoardSummary[] = [
  {
    id: "classic",
    name_key: "board.classic.name",
    tile_count: 40,
    ownable_count: 28,
    catalogue_ready: true,
  },
];

/** A board the picker must not offer: its forty square names resolve to nothing (MON-419, G-46). */
export const UNNAMED_BOARD: BoardSummary = {
  id: "atlantis",
  name_key: "board.classic.name",
  tile_count: 40,
  ownable_count: 28,
  catalogue_ready: false,
};

/** Both rule sets, as `/rulesets` now returns them — labelled, with no flags to explain here. */
export const RULESETS: readonly RulesetView[] = [UNIVERSAL_VIEW, KIDS_VIEW];

/** A real forty-square ring, so every square name resolves in the catalogue (G-F17). */
export function gameView(
  overrides: Partial<GameStateView> = {},
  commands: readonly Command[] = [],
  /**
   * The log the view arrives with, for a caller that needs the event log or the replay to have
   * something in it. Empty by default: most tests are about a screen rather than a history, and a
   * fixture log they did not ask for would put sentences in the ledger they then have to exclude.
   */
  events: readonly LoggedEvent[] = [],
): GameView {
  return makeView({
    board: makeRingBoard(),
    state: makeRingState(overrides),
    legal_commands: [...commands],
    events: [...events],
    event_cursor: events.length,
  });
}

/**
 * A short, real history: Ruti rolls, lands on square 9, buys it and pays for it.
 *
 * Enough to give the event log sentences and the replay viewer a slider with something on it. Kept to
 * four events with one `cash_changed`, because the point is that the surfaces have content rather
 * than that any particular turn is reproduced — the golden games in the engine own that.
 */
export const SHORT_LOG: readonly LoggedEvent[] = [
  loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 }),
  loggedEvent(2, {
    type: "dice_rolled",
    player: 0,
    first: 4,
    second: 5,
    total: 9,
    doubles_streak: 0,
    purpose: "move",
  }),
  loggedEvent(3, {
    type: "token_moved",
    player: 0,
    from_tile: 0,
    to_tile: 9,
    forward: true,
    passed_go: false,
  }),
  loggedEvent(4, {
    type: "cash_changed",
    player: 0,
    delta: -100,
    balance: 1400,
    reason: "purchase",
    counterparty: "bank",
  }),
];

export function renderApp(edge: Edge): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App client={edge.client} />
    </QueryClientProvider>,
  );
}

/** Put a game in the address bar, which is where the shell keeps it. */
export function openGameUrl(gameId: string): void {
  globalThis.history.pushState({}, "", `/?game=${gameId}`);
}

/** The routes a game screen needs: the two lists, the view, and a command sink. */
export function gameEdge(view: GameView): Edge {
  return makeEdge({
    "GET /api/boards": ok(BOARDS),
    "GET /api/rulesets": ok(RULESETS),
    "GET /api/games/g1": ok(view),
    "POST /api/games/g1/commands": ok(view),
  });
}
