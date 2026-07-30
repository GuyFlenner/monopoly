/**
 * The integration tests: what the shell is *for*, in the order a defect would hurt.
 *
 * 1. **The two screens connect.** A posted game moves the app to that game's board. Until this
 *    passed, eleven individually tested components were still not a playable product.
 * 2. **`legal_commands` reaches the bar unchanged** — one chit per command the engine offered,
 *    counted on the composition rather than inside `ActionBar` (ADR-005).
 * 3. **One owner for every live region.** The D1 defect (two regions announcing one dice roll) is
 *    a *composition* defect: every component is individually silent, and the way it comes back is
 *    somebody mounting a second `<Announcer>` or a `role="status"` in the shell. So the assertion
 *    is over the whole mounted app, and it is about ownership rather than a count of one — the
 *    Announcer deliberately owns two regions, one polite and one assertive (spec §5.5).
 * 4. **Panels follow `state.interrupts`, not a guess.** An auction frame shows the auction, a
 *    trade frame shows the trade panel, and an ordinary phase shows neither.
 * 5. **Failures degrade honestly.** An `ApiError` renders its translated reason; a dropped socket
 *    leaves the board on screen, because losing the push does not lose the game.
 * 6. **Holdings are public.** A non-current player's dossier is reachable on somebody else's turn.
 *
 * The fakes go in at the edge — a `fetch` and a socket factory handed to a real `ApiClient` — so
 * every test drives the real client, the real query cache and the real event queue.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ApiClient, type FetchLike, type SocketLike } from "./api";
import type { BoardSummary, Command, GameStateView, GameView, RentQuote, RulesetView } from "./api";
import { makeRingBoard, makeRingState } from "./board/fixtures";
import { useUiStore } from "./game";
import { KIDS_VIEW, UNIVERSAL_VIEW } from "./panels/SetupScreenFixtures";
import { KIDS_RULESET, makeView } from "./test/fixtures";
import { COMFORT_ATTRIBUTE, KIDS_COMFORT } from "./theme";

// --- The fake edge ----------------------------------------------------------

/** The sockets the app opened, so a test can drop one. */
const sockets: FakeSocket[] = [];

class FakeSocket implements SocketLike {
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

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function refusal(
  status: number,
  reasonKey: string,
  params: Record<string, string | number> = {},
): Reply {
  return { status, body: { reason_key: reasonKey, params } };
}

/** `Method /path` (query stripped) -> reply. A request with no route is a test bug, and says so. */
type Routes = Readonly<Record<string, Reply>>;

interface Edge {
  readonly client: ApiClient;
  readonly calls: { method: string; path: string; body: unknown }[];
}

function makeEdge(routes: Routes, options: { readonly hang?: boolean } = {}): Edge {
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

const BOARDS: readonly BoardSummary[] = [
  {
    id: "classic",
    name_key: "board.classic.name",
    tile_count: 40,
    ownable_count: 28,
    catalogue_ready: true,
  },
];

/** A board the picker must not offer: its forty square names resolve to nothing (MON-419). */
const UNNAMED_BOARD: BoardSummary = {
  id: "atlantis",
  name_key: "board.classic.name",
  tile_count: 40,
  ownable_count: 28,
  catalogue_ready: false,
};

/** Both rule sets, as `/rulesets` now returns them — labelled, with no flags to explain here. */
const RULESETS: readonly RulesetView[] = [UNIVERSAL_VIEW, KIDS_VIEW];

const ROLL: Command = { kind: "roll_dice", player: 0 };
const END_TURN: Command = { kind: "end_turn", player: 0 };

/** A real forty-square ring, so every square name resolves in the catalogue (G-F17). */
function gameView(
  overrides: Partial<GameStateView> = {},
  commands: readonly Command[] = [],
): GameView {
  return makeView({
    board: makeRingBoard(),
    state: makeRingState(overrides),
    legal_commands: [...commands],
  });
}

function renderApp(edge: Edge): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App client={edge.client} />
    </QueryClientProvider>,
  );
}

/** Put a game in the address bar, which is where the shell keeps it. */
function openGameUrl(gameId: string): void {
  globalThis.history.pushState({}, "", `/?game=${gameId}`);
}

beforeEach(() => {
  sockets.length = 0;
  globalThis.history.pushState({}, "", "/");
  useUiStore.setState({ selectedTile: null, selectedPlayer: null, panel: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- The setup screen -------------------------------------------------------

describe("App — the setup screen", () => {
  it("posts a new game and moves to that game's board", async () => {
    const created = gameView({}, [ROLL]);
    const edge = makeEdge({
      "GET /api/boards": ok(BOARDS),
      "GET /api/rulesets": ok(RULESETS),
      "POST /api/games": ok(created),
      "GET /api/games/g1": ok(created),
    });
    renderApp(edge);

    const names = await screen.findAllByLabelText("Name");
    expect(names).toHaveLength(2);
    await userEvent.type(names[0] as HTMLElement, "Ruti");
    await userEvent.type(names[1] as HTMLElement, "Dan");
    await userEvent.click(screen.getByRole("button", { name: "Start the game" }));

    expect(await screen.findByTestId("board-grid")).toBeInTheDocument();
    const posted = edge.calls.find((call) => call.method === "POST");
    expect(posted?.path).toBe("/api/games");
    expect(new URLSearchParams(globalThis.location.search).get("game")).toBe("g1");
  });

  it("shows the loading state from the catalogue while the two lists are in flight", () => {
    renderApp(makeEdge({}, { hang: true }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the server's own reason key when a list cannot be fetched", async () => {
    const edge = makeEdge({
      "GET /api/boards": refusal(404, "error.game_not_found"),
      "GET /api/rulesets": ok(RULESETS),
    });
    renderApp(edge);

    expect(await screen.findByText("That game no longer exists.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("says so rather than offering an empty picker when the server has no boards", async () => {
    const edge = makeEdge({ "GET /api/boards": ok([]), "GET /api/rulesets": ok(RULESETS) });
    renderApp(edge);

    expect(await screen.findByText("The server has no boards to play on.")).toBeInTheDocument();
  });

  it("never offers a board whose squares have no names", async () => {
    // MON-419 / G-46. `catalogue_ready` is the server's flag, and a board without it would paint
    // forty blanks. Both boards carry the *same* `name_key` here on purpose: the picker must filter
    // on the flag rather than on whether it happens to recognise the name.
    const edge = makeEdge({
      "GET /api/boards": ok([...BOARDS, UNNAMED_BOARD]),
      "GET /api/rulesets": ok(RULESETS),
    });
    renderApp(edge);

    await screen.findAllByLabelText("Name");
    const offered = screen.getAllByRole("radio", { name: /Classic/ });
    expect(offered).toHaveLength(1);
    expect((offered[0] as HTMLInputElement).value).toBe("classic");
  });

  it("says there are no boards when every board it was offered is unnamed", async () => {
    // The two causes are one sentence from a parent's side, which is why the filter runs before the
    // empty check rather than inside `SetupScreen`.
    const edge = makeEdge({
      "GET /api/boards": ok([UNNAMED_BOARD]),
      "GET /api/rulesets": ok(RULESETS),
    });
    renderApp(edge);

    expect(await screen.findByText("The server has no boards to play on.")).toBeInTheDocument();
  });
});

// --- The game screen --------------------------------------------------------

describe("App — the game screen", () => {
  function gameEdge(view: GameView): Edge {
    return makeEdge({
      "GET /api/boards": ok(BOARDS),
      "GET /api/rulesets": ok(RULESETS),
      "GET /api/games/g1": ok(view),
      "POST /api/games/g1/commands": ok(view),
    });
  }

  describe("the rent a square would charge (MON-420)", () => {
    /**
     * Forty quotes, index-aligned with the ring, with one square priced.
     *
     * Everything on screen has to come off this: the multipliers live in `rules/rent.py`, so before
     * `rent_quotes` existed the panel could say what a square *was* and not what it would cost.
     */
    function withQuote(tile: number, quote: RentQuote | null): GameView {
      const quotes = Array.from({ length: 40 }, () => null as RentQuote | null);
      quotes[tile] = quote;
      return gameView({ rent_quotes: quotes });
    }

    async function openSquare(view: GameView, tile: number): Promise<void> {
      openGameUrl("g1");
      renderApp(gameEdge(view));
      await screen.findByTestId("board-grid");
      act(() => {
        useUiStore.setState({ selectedTile: tile });
      });
    }

    it("shows the figure and the engine's own explanation of it", async () => {
      await openSquare(
        withQuote(1, {
          owner: 1,
          tile: 1,
          amount: 4,
          base_rent: 2,
          houses: 0,
          multiplier: 2,
          dice_total: null,
          group: "brown",
          note_keys: ["rent.note.full_group_doubled"],
          note_params: { group_key: "group.brown", multiplier: 2 },
        }),
        1,
      );

      const panel = await screen.findByTestId("square-rent");
      expect(panel.textContent).toContain("4");
      // The note, with its group key resolved — the same resolver the log uses (MON-415).
      expect(panel.textContent).toContain("Brown");
      expect(panel.textContent).not.toContain("group.");
    });

    it("states a utility's multiplier and no amount, because the throw has not happened", async () => {
      await openSquare(
        withQuote(12, {
          owner: 1,
          tile: 12,
          amount: null,
          base_rent: 0,
          houses: 0,
          multiplier: 4,
          dice_total: null,
          group: null,
          note_keys: ["rent.note.utility_quote"],
          note_params: { multiplier: 4 },
        }),
        12,
      );

      const panel = await screen.findByTestId("square-rent");
      // No invented figure: the caveat is the sentence, not a number nothing stands behind.
      expect(screen.queryByTestId("square-rent-amount")).not.toBeInTheDocument();
      expect(panel.textContent).toContain("4 × whatever the dice show");
    });

    it("says nothing at all about rent on a square that charges none", async () => {
      // The engine quotes `null` for unowned, mortgaged and self-owned squares, so there is no
      // branch in the UI about what any of those mean — and no "Rent 0" either.
      await openSquare(withQuote(1, null), 1);
      // The square's own panel is open — so the absence below is the rent line, not the whole note.
      expect(await screen.findByText("Selected square")).toBeInTheDocument();
      expect(screen.queryByTestId("square-rent")).not.toBeInTheDocument();
    });
  });

  it("renders one action chit per legal command, and nothing it was not offered", async () => {
    openGameUrl("g1");
    const { container } = renderApp(gameEdge(gameView({}, [ROLL, END_TURN])));

    await screen.findByTestId("board-grid");
    const chits = container.querySelectorAll("[data-command-kind]");
    expect(chits).toHaveLength(2);
    expect([...chits].map((chit) => chit.getAttribute("data-command-kind"))).toEqual([
      "roll_dice",
      "end_turn",
    ]);
    expect(screen.getByRole("button", { name: /Roll the dice/ })).toBeInTheDocument();
  });

  it("sends the command the bar was given, unaltered", async () => {
    openGameUrl("g1");
    const edge = gameEdge(gameView({}, [ROLL]));
    renderApp(edge);

    await screen.findByTestId("board-grid");
    await userEvent.click(screen.getByRole("button", { name: /Roll the dice/ }));

    await waitFor(() => {
      const posted = edge.calls.find((call) => call.path === "/api/games/g1/commands");
      expect(posted?.body).toEqual({ command: ROLL });
    });
  });

  it("mounts every aria-live region inside the one Announcer", async () => {
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));
    await screen.findByTestId("board-grid");

    // Over the whole document rather than the render container, so a portalled region would still
    // be caught. Two regions, both the Announcer's: polite and assertive (spec §5.5).
    const live = [...document.body.querySelectorAll("[aria-live]")];
    expect(live).toHaveLength(2);
    expect(live.every((region) => region.hasAttribute("data-announcer"))).toBe(true);
    // The roles that carry an implicit live region, which an attribute audit alone would miss.
    expect(
      document.body.querySelectorAll('[role="status"], [role="alert"], [role="log"]'),
    ).toHaveLength(0);
  });

  it("shows the auction panel when the live interrupt frame is an auction", async () => {
    openGameUrl("g1");
    const auction = {
      kind: "auction" as const,
      resume: "awaiting_roll" as const,
      lot: { kind: "tile" as const, tile: 1 },
      reason: "declined_purchase" as const,
      eligible: [0, 1],
      active: [0, 1],
      turn: 0,
      high_bid: 0,
      high_bidder: null,
      min_bid: 10,
      max_bid: 200,
      queue: [],
      withdrawn: [],
    };
    renderApp(gameEdge(gameView({ phase: "auction", interrupts: [auction] })));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Auction" })).toBeInTheDocument();
  });

  /**
   * MON-422's acceptance criterion, and the assertion that used to encode the defect.
   *
   * This test previously asserted the heading "Offer a trade" — the *builder's* title — on a review
   * frame, and passed while the panel showed the recipient two empty trays and none of the offer. A
   * test can be green and still be describing the bug.
   *
   * The criterion the item states: a review frame renders the offer's **actual contents** — a named
   * property and a cash figure that are in the frame and in neither tray's default. So the fixture
   * puts a tile on one side and cash on the other, and both are read off the screen.
   */
  it("renders the pending offer's real contents on a trade-review frame", async () => {
    openGameUrl("g1");
    const trade = {
      kind: "trade" as const,
      resume: "awaiting_roll" as const,
      offer: {
        proposer: 0,
        recipient: 1,
        // Tile 1 is a real square on the ring fixture, so its name has to be looked up rather than
        // guessed — which is the part that was missing.
        give: { cash: 50, tiles: [1], jail_cards: [] },
        receive: { cash: 125, tiles: [], jail_cards: [] },
      },
    };
    renderApp(gameEdge(gameView({ phase: "trade_review", interrupts: [trade] })));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "An offer for you" })).toBeInTheDocument();

    // Both figures, from opposite sides of the offer. Neither is a default: an empty tray shows no
    // cash row at all, so reading "50" and "125" can only come from the frame.
    const cash = within(dialog)
      .getAllByTestId("offer-cash")
      .map((node) => node.textContent);
    expect(cash).toEqual(["50", "125"]);

    // The named square, and the side it is on. `data-owner` is the player id, so this also catches
    // the give/receive sides being rendered the wrong way round — which would show a player the
    // opposite of the deal.
    const tile = within(dialog).getByTestId("offer-tile");
    expect(tile).toHaveAttribute("data-tile", "1");
    expect(tile.closest("[data-testid='offer-side']")).toHaveAttribute("data-owner", "0");

    // And the two answers are in the panel, not on the bar behind it.
    expect(within(dialog).getByTestId("trade-accept")).toBeInTheDocument();
    expect(within(dialog).getByTestId("trade-decline")).toBeInTheDocument();
  });

  it("sends respond_to_trade for the recipient, not for whoever's turn it is", async () => {
    openGameUrl("g1");
    // The proposer's turn is interrupted by the review, so "current player" is 0 while the only seat
    // that may answer is 1. The engine rejects the wrong one with `error.not_trade_recipient`, so
    // reading the acting seat here would make accept fail for the player looking at it.
    const trade = {
      kind: "trade" as const,
      resume: "awaiting_roll" as const,
      offer: {
        proposer: 0,
        recipient: 1,
        give: { cash: 50, tiles: [], jail_cards: [] },
        receive: { cash: 0, tiles: [], jail_cards: [] },
      },
    };
    const edge = gameEdge(
      gameView({ phase: "trade_review", current_player_id: 0, interrupts: [trade] }),
    );
    renderApp(edge);

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByTestId("trade-accept"));

    const posted = edge.calls.find((call) => call.path.endsWith("/commands"));
    expect(posted?.body).toEqual({
      command: { kind: "respond_to_trade", player: 1, accept: true },
    });
  });

  it("shows neither panel when the phase is an ordinary one", async () => {
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));

    await screen.findByTestId("board-grid");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders an ApiError's translated reason instead of a blank board", async () => {
    openGameUrl("g1");
    const edge = makeEdge({
      "GET /api/boards": ok(BOARDS),
      "GET /api/rulesets": ok(RULESETS),
      "GET /api/games/g1": refusal(404, "error.game_not_found"),
    });
    renderApp(edge);

    expect(await screen.findByText("That game no longer exists.")).toBeInTheDocument();
    // And a way out of a game id that no longer resolves.
    expect(screen.getByRole("button", { name: "New game" })).toBeInTheDocument();
  });

  it("keeps the board on screen when the event socket drops", async () => {
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));
    await screen.findByTestId("board-grid");

    const socket = sockets[0];
    expect(socket).toBeDefined();
    // `act` because the socket's callbacks are outside React's knowledge: they are how the real
    // transport reports a drop, and the status they set is React state.
    act(() => {
      socket?.onopen?.({});
      socket?.onclose?.({ code: 1006, reason: "", wasClean: false });
    });

    expect(await screen.findByTestId("connection-note")).toHaveTextContent("Reconnecting");
    expect(screen.getByTestId("board-grid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Roll the dice/ })).toBeInTheDocument();
  });

  it("reaches any player's dossier, including on somebody else's turn", async () => {
    openGameUrl("g1");
    renderApp(gameEdge(gameView({ current_player_id: 0 }, [ROLL])));
    await screen.findByTestId("board-grid");

    // Ruti is playing; Dan's holdings are public all the same (spec §5.2).
    expect(screen.getByTestId("player-dossier")).toHaveAttribute("data-player", "0");
    await userEvent.click(screen.getByRole("button", { name: "Dan" }));

    const dossier = screen.getByTestId("player-dossier");
    expect(dossier).toHaveAttribute("data-player", "1");
    expect(dossier).toHaveAttribute("data-current", "false");
  });

  /**
   * Kids Mode, asserted on the composition (MON-604).
   *
   * This is the level the acceptance criterion lives at. "Auction and mortgage affordances absent,
   * not disabled" is not a property of any one component — every one of them is individually
   * innocent, because the auction panel is mounted from an interrupt frame and the mortgage chit
   * comes from `legal_commands`. What could be wrong is the *shell*: a panel mounted on a guess, a
   * chit rendered `disabled`, a comfort scale that never reaches the subtree. So the fixture is a
   * whole kids game and the assertions are over the mounted app.
   *
   * Note the negative assertions are paired with a positive one each time. `queryByText(...)` being
   * null is also what a blank screen looks like, and a test that only checks absence passes hardest
   * when nothing renders at all.
   */
  describe("Kids Mode (MON-604)", () => {
    function kidsGame(commands: readonly Command[] = [ROLL]): Edge {
      return gameEdge(gameView({ ruleset: KIDS_RULESET }, commands));
    }

    it("steps the whole subtree's hit targets up rather than one component's", async () => {
      openGameUrl("g1");
      const { container } = renderApp(kidsGame());
      await screen.findByTestId("board-grid");

      const scoped = container.querySelectorAll(`[${COMFORT_ATTRIBUTE}="${KIDS_COMFORT}"]`);
      expect(scoped, "the comfort scale is not switched on anywhere").toHaveLength(1);
      // On an ancestor of the controls, not beside them — that is what makes it reach the chits, the
      // seat picker, the dice toggle and every dialog rendered inside the screen.
      expect(scoped[0]?.querySelector("[data-command-kind]")).not.toBeNull();
    });

    it("leaves the floor alone under the full rules", async () => {
      openGameUrl("g1");
      const { container } = renderApp(gameEdge(gameView({}, [ROLL])));
      await screen.findByTestId("board-grid");
      expect(container.querySelectorAll(`[${COMFORT_ATTRIBUTE}]`)).toHaveLength(0);
    });

    it("renders no auction panel and no mortgage chit, disabled or otherwise", async () => {
      openGameUrl("g1");
      // A legal set with a mortgage in it would be a contract violation in a kids game, so the
      // honest fixture is the set the engine would send: no mortgage, no bid, no withdrawal.
      renderApp(kidsGame([ROLL, END_TURN]));
      await screen.findByTestId("board-grid");

      const chits = [...document.querySelectorAll("[data-command-kind]")].map((chit) =>
        chit.getAttribute("data-command-kind"),
      );
      expect(chits, "the bar renders something").not.toHaveLength(0);
      expect(chits).not.toContain("mortgage_property");
      expect(chits).not.toContain("place_bid");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // Absent, not disabled: no chit in the product is ever `disabled`, and this is the composition
      // where a "kids mode" would be tempted to add one.
      for (const chit of document.querySelectorAll("[data-command-kind]")) {
        expect(chit).not.toHaveAttribute("disabled");
        expect(chit).not.toHaveAttribute("aria-disabled");
      }
    });

    it("reads its buttons and headings in the simpler wording", async () => {
      openGameUrl("g1");
      renderApp(kidsGame());
      await screen.findByTestId("board-grid");
      // A pattern rather than an exact name: the hinted chit's accessible name also carries the
      // "Suggested" badge, which is a feature — a screen reader should hear the mark.
      expect(screen.getByRole("button", { name: /Throw the dice/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Roll the dice/ })).not.toBeInTheDocument();
      expect(screen.getByText("What you can do")).toBeInTheDocument();
      expect(screen.getByText("What everyone has")).toBeInTheDocument();
    });

    it("shows whose turn it is with a piece and a name, prominently", async () => {
      openGameUrl("g1");
      renderApp(kidsGame());
      await screen.findByTestId("board-grid");

      const banner = screen.getByTestId("turn-banner");
      expect(banner.dataset.kids).toBe("true");
      expect(within(banner).getByTestId("turn-banner-name")).toHaveTextContent("Ruti");
      // The piece, not only the name: the channel a pre-reader is actually using.
      expect(banner.querySelector("svg path")).not.toBeNull();
    });

    it("opens the hint and marks the move it points at (MON-605)", async () => {
      openGameUrl("g1");
      renderApp(kidsGame([END_TURN, ROLL]));
      await screen.findByTestId("board-grid");

      expect(screen.getByTestId("hint-panel").dataset.prominent).toBe("true");
      expect(screen.getByTestId("hint-reason")).toHaveTextContent("Every turn starts with a roll");
      // The mark lands on the chit the ranking chose, which is the roll rather than the first
      // command the engine happened to list.
      const marked = document.querySelectorAll('[data-hinted="true"]');
      expect(marked).toHaveLength(1);
      expect(marked[0]?.getAttribute("data-command-kind")).toBe("roll_dice");
    });

    it("keeps the hint folded and unmarked under the full rules", async () => {
      openGameUrl("g1");
      renderApp(gameEdge(gameView({}, [END_TURN, ROLL])));
      await screen.findByTestId("board-grid");

      const panel = screen.getByTestId("hint-panel");
      expect(panel.dataset.prominent).toBe("false");
      expect(panel).not.toHaveAttribute("open");
      expect(document.querySelectorAll('[data-hinted="true"]')).toHaveLength(0);
      // Available, though — that is the difference between quieter and absent.
      expect(screen.getByText("Show a hint")).toBeInTheDocument();
    });

    it("still mounts exactly the two live regions the Announcer owns", async () => {
      // The hint speaks, which is the newest way a third region could arrive (GAP D1/G-54).
      openGameUrl("g1");
      const { container } = renderApp(kidsGame());
      await screen.findByTestId("board-grid");
      expect(container.querySelectorAll("[aria-live]")).toHaveLength(2);
      expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    });
  });

  /**
   * M5's definition of done, as an assertion: "switchable mid-game and no effect on game state".
   *
   * The claim is about what a language change may touch, so it is tested at the level where game
   * state exists — the mounted app with a real view in the query cache — rather than on the switch
   * in isolation. What must survive is the projection (the board, the seat on screen, the legal
   * commands the engine offered) and the UI-local state that is nobody's business but this
   * package's (which dossier is open).
   *
   * It must also not refetch: a language change that invalidated the game query would round-trip
   * and *look* fine here while being a defect on a real network, so the request count is asserted
   * too. Language is not a fact the server holds.
   */
  it("changes language mid-game without disturbing the game", async () => {
    openGameUrl("g1");
    const edge = gameEdge(gameView({ current_player_id: 0 }, [ROLL, END_TURN]));
    renderApp(edge);
    await screen.findByTestId("board-grid");

    // Put the UI somewhere non-default first, so a remount would be visible.
    await userEvent.click(screen.getByRole("button", { name: "Dan" }));
    expect(screen.getByTestId("player-dossier")).toHaveAttribute("data-player", "1");

    const requestsBefore = edge.calls.length;
    const boardBefore = screen.getByTestId("board-grid");

    await userEvent.click(screen.getByTestId("locale-he"));

    // The catalogue moved: the same command is offered under its Hebrew label, not its English one.
    // `action.roll_dice` has Hebrew, which is what makes this a real check on the switch rather
    // than on a fallback.
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("lang", "he");
    });
    expect(screen.queryByRole("button", { name: /Roll the dice/ })).not.toBeInTheDocument();

    // The game did not move.
    expect(screen.getByTestId("board-grid")).toBe(boardBefore);
    expect(screen.getByTestId("player-dossier")).toHaveAttribute("data-player", "1");
    const chits = screen
      .getByTestId("board-grid")
      .ownerDocument.querySelectorAll("[data-command-kind]");
    expect([...chits].map((chit) => chit.getAttribute("data-command-kind"))).toEqual([
      "roll_dice",
      "end_turn",
    ]);
    expect(edge.calls.length, "a language change must not refetch the game").toBe(requestsBefore);
  });
});
