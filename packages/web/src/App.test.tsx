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
 * every test drives the real client, the real query cache and the real event queue. That scaffolding
 * lives in `test/appHarness.tsx` since MON-703, because the accessibility sweep needs the same
 * mounted app and two fake edges would drift.
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Command, GameView, RentQuote } from "./api";
// Straight from the fixtures rather than through the harness: the Israeli-board rent test builds a
// board of its own — forty remapped `name_key`s — which is a fixture concern and not one the shared
// app harness should learn.
import { makeProperties, makeRingBoard, makeRingState } from "./board/fixtures";
import { useUiStore } from "./game";
// The file rather than the barrel: the preference is not part of `@/game`'s public surface, and a
// test reaching for its storage key is exactly the caller that should have to say where it lives.
import { AUTO_END_TURN_STORAGE_KEY, forgetCachedAutoEndTurn } from "./game/autoEndTurnPreference";
import {
  BOARDS,
  type Edge,
  gameEdge,
  gameView,
  makeEdge,
  ok,
  openGameUrl,
  refusal,
  renderApp,
  RULESETS,
  sockets,
  UNNAMED_BOARD,
} from "./test/appHarness";
import { KIDS_RULESET, loggedEvent, makePlayer, makeView } from "./test/fixtures";
import { COMFORT_ATTRIBUTE, KIDS_COMFORT } from "./theme";

const ROLL: Command = { kind: "roll_dice", player: 0 };
const END_TURN: Command = { kind: "end_turn", player: 0 };

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
    // Scoped to the placeholder, because since MON-708 the sentence is in *two* places and both are
    // deliberate: the visible `<LoadingState>` and the polite live region it announced itself
    // through. An unscoped `getByText` finds both and fails, which is the assertion below.
    expect(screen.getByTestId("setup-loading")).toHaveTextContent("Loading…");
  });

  it("announces a wait politely through the one Announcer rather than a region of its own", async () => {
    // MON-708: "loading states announced politely via the existing Announcer (no new live regions)".
    // A wait nobody is told about is a blank screen to a screen-reader user, and a wait announced
    // from a region the loading component rendered itself is the GAP D1/G-54 double-speak defect.
    renderApp(makeEdge({}, { hang: true }));

    const polite = await waitFor(() => {
      const region = document.querySelector('[data-announcer="polite"]');
      expect(region).toHaveTextContent("Loading…");
      return region;
    });
    // The sentence is in the *shared* region, and no second one appeared to carry it.
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(2);
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

  it("loads a saved game and moves to that game's board (MON-704)", async () => {
    // The whole of "a loaded game is just a game": the load route answers a `GameView` exactly as
    // `POST /games` does, so the response is cached under the game's key and the screen switches
    // through the same two lines. Nothing downstream of the shell has a branch for it.
    const restored = gameView({}, [ROLL]);
    const edge = makeEdge({
      "GET /api/boards": ok(BOARDS),
      "GET /api/rulesets": ok(RULESETS),
      "POST /api/games/load": ok(restored),
      "GET /api/games/g1": ok(restored),
    });
    renderApp(edge);

    const picker = await screen.findByLabelText("Choose a saved game file");
    await userEvent.upload(
      picker,
      new File([JSON.stringify({ schema_version: 1, game_id: "g1" })], "save.json", {
        type: "application/json",
      }),
    );

    expect(await screen.findByTestId("board-grid")).toBeInTheDocument();
    const posted = edge.calls.find((call) => call.path === "/api/games/load");
    expect(posted?.body).toEqual({ schema_version: 1, game_id: "g1" });
    expect(new URLSearchParams(globalThis.location.search).get("game")).toBe("g1");
  });

  it("keeps the load affordance reachable when the two lists failed", async () => {
    // A save carries its own board and rule set, so a server that cannot list its boards is still a
    // server that can resume yesterday's game. Hiding the one working affordance behind an unrelated
    // failure is the "no spinners forever" defect wearing an error message.
    // A 404 rather than a 5xx: `SetupFlow` retries a server-side failure twice before settling, so a
    // 500 here would be a test waiting on a backoff to assert something unrelated to it.
    const edge = makeEdge({
      "GET /api/boards": refusal(404, "error.not_found"),
      "GET /api/rulesets": ok(RULESETS),
    });
    renderApp(edge);

    await screen.findByTestId("setup-error");
    expect(screen.getByLabelText("Choose a saved game file")).toBeInTheDocument();
  });

  it("keeps the load affordance reachable when the server has no boards", async () => {
    const edge = makeEdge({ "GET /api/boards": ok([]), "GET /api/rulesets": ok(RULESETS) });
    renderApp(edge);

    await screen.findByTestId("setup-empty");
    expect(screen.getByLabelText("Choose a saved game file")).toBeInTheDocument();
  });
});

// --- The game screen --------------------------------------------------------

describe("App — the game screen", () => {
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

    it("names the city, not the colour, when the Israeli board is in play", async () => {
      /*
        The third site the group name reaches, after the dossier's bands and the event log. All three
        take the same `GroupNameScope` and go through `i18n/groupNames.ts`, so the sentence a player
        reads before landing on Allenby St. says "the whole Tel Aviv set" — the same words the log
        will say afterwards, and the same words the dossier's band carries.

        The square names are remapped onto `tile.israel.*` because `board/Board.tsx` resolves a tile
        name against the board namespace with no `exists` guard, so a classic key under
        `board-israel` would throw. Unrelated to group names; noted so the remap does not look
        superstitious.
      */
      const quotes = Array.from({ length: 40 }, () => null as RentQuote | null);
      quotes[37] = {
        owner: 1,
        tile: 37,
        amount: 100,
        base_rent: 50,
        houses: 0,
        multiplier: 2,
        dice_total: null,
        group: "dark_blue",
        note_keys: ["rent.note.full_group_doubled"],
        note_params: { group_key: "group.dark_blue", multiplier: 2 },
      };
      const ring = makeRingBoard({ id: "israel" });
      await openSquare(
        makeView({
          board: {
            ...ring,
            tiles: ring.tiles.map((tile) => ({
              ...tile,
              name_key: `tile.israel.t${String(tile.index).padStart(2, "0")}`,
            })),
          },
          state: makeRingState({ rent_quotes: quotes }),
        }),
        37,
      );

      const panel = await screen.findByTestId("square-rent");
      expect(panel.textContent).toContain("Tel Aviv");
      expect(panel.textContent).not.toContain("Dark blue");
      expect(panel.textContent).not.toContain("dark blue");
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

  /**
   * Why a house cannot go on a square (MON-725).
   *
   * The owner's report behind MON-724 had a second half: *"and if I don't have money — to alert"*.
   * The absent chit is `ActionBar`'s mechanism and stays so; this is the surface that says why, and
   * the sentence is the engine's — asked through `POST /validate`, never worked out here.
   */
  describe("whether a house can go here (MON-725)", () => {
    /** A ring with square 1 owned by Dan, and a `validate` route answering `verdict`. */
    function ownedSquareEdge(
      verdict: unknown,
      properties: Readonly<Record<number, { readonly owner: number }>> = { 1: { owner: 1 } },
    ) {
      const view = makeView({
        board: makeRingBoard(),
        state: makeRingState({ properties: makeProperties(properties) }),
      });
      return makeEdge({
        "GET /api/boards": ok(BOARDS),
        "GET /api/rulesets": ok(RULESETS),
        "GET /api/games/g1": ok(view),
        "POST /api/games/g1/commands": ok(view),
        "POST /api/games/g1/validate": ok(verdict),
      });
    }

    async function openSquareOn(edge: ReturnType<typeof makeEdge>, tile: number): Promise<void> {
      openGameUrl("g1");
      renderApp(edge);
      await screen.findByTestId("board-grid");
      act(() => {
        useUiStore.setState({ selectedTile: tile });
      });
    }

    it("tells a player who cannot afford it exactly how short they are", async () => {
      // The sentence MON-723 wrote, on screen for the first time: before this, a player holding a
      // complete set and short of cash saw no button and no reason — the same screen as a player
      // who held nothing.
      const edge = ownedSquareEdge({
        legal: false,
        reason_key: "error.insufficient_funds",
        params: { required: 100, available: 60 },
      });
      await openSquareOn(edge, 1);

      const panel = await screen.findByTestId("square-build");
      expect(panel).toHaveTextContent(/costs .*100.* and you have .*60/);
      // Asked about the *owner* of the square, not about whoever's turn it is.
      const asked = edge.calls.find((call) => call.path.endsWith("/validate"));
      expect(asked?.body).toEqual({ command: { kind: "build_house", player: 1, tile: 1 } });
    });

    it("says a house can go here when the engine says it can", async () => {
      await openSquareOn(ownedSquareEdge({ legal: true, reason_key: null, params: {} }), 1);
      expect(await screen.findByTestId("square-build")).toHaveTextContent("A house can go here.");
    });

    it("does not ask about a square nobody owns", async () => {
      // "You cannot build on a square nobody owns" is the one answer a player already has, and it
      // would appear on every square they open while looking for somewhere to land.
      const edge = ownedSquareEdge({ legal: true, reason_key: null, params: {} }, {});
      await openSquareOn(edge, 1);
      expect(await screen.findByText("Selected square")).toBeInTheDocument();
      await waitFor(() => {
        expect(edge.calls.some((call) => call.path.endsWith("/validate"))).toBe(false);
      });
      expect(screen.queryByTestId("square-build")).not.toBeInTheDocument();
    });

    it("does not ask about a railroad, which no house can ever go on", async () => {
      // Square 5 is a railroad in the ring fixture. `kind` is board data, so this costs no rule.
      const edge = ownedSquareEdge(
        { legal: true, reason_key: null, params: {} },
        { 5: { owner: 1 } },
      );
      await openSquareOn(edge, 5);
      expect(await screen.findByText("Selected square")).toBeInTheDocument();
      await waitFor(() => {
        expect(edge.calls.some((call) => call.path.endsWith("/validate"))).toBe(false);
      });
      expect(screen.queryByTestId("square-build")).not.toBeInTheDocument();
    });
  });

  /**
   * Whose moves the bar offers on one shared screen (MON-726).
   *
   * `legal_commands` answers for every seat that *may* act (MON-204), so a game with a bot in it put
   * the bot's builds on the bar as rows nothing distinguished from the player's own. This is the
   * whole composition — real client, real query cache — because the filter lives in `GameScreen` and
   * the label lives in `ActionBar`, and the defect is only visible where the two meet.
   */
  describe("whose moves reach the bar (MON-726)", () => {
    /** Seat 0 human (current), seat 1 human, seat 2 a bot — each with a buildable street. */
    const TABLE = [
      makePlayer(0, { name: "Ruti" }),
      makePlayer(1, { name: "Dan" }),
      makePlayer(2, { name: "Robo", kind: { bot_level: "normal" }, is_bot: true }),
    ];

    const BUILDS: readonly Command[] = [
      ROLL,
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "build_house", player: 1, tile: 3 },
      { kind: "build_house", player: 2, tile: 6 },
    ];

    async function openTable(): Promise<void> {
      openGameUrl("g1");
      renderApp(
        gameEdge(
          makeView({
            board: makeRingBoard(),
            state: makeRingState({ players: TABLE, current_player_id: 0 }),
            legal_commands: [...BUILDS],
          }),
        ),
      );
      await screen.findByTestId("board-grid");
      // MON-724 opens the estate zone on a build, so the chits are already revealed.
    }

    function buildChits(): readonly HTMLElement[] {
      return screen
        .queryAllByRole("button")
        .filter((button) => button.dataset.commandKind === "build_house");
    }

    it("does not offer a bot's estate, which the bot plays itself", async () => {
      await openTable();
      await waitFor(() => {
        expect(buildChits()).toHaveLength(2);
      });
      /*
        Asserted over the chits rather than the page. "Oriental Avenue" is legitimately on the *board*
        and "Robo" is legitimately in the seat picker — holdings are public and every seat is listed
        on anybody's turn (spec §5.2). What must not exist is a *button* that builds there.
      */
      const offered = buildChits().map((chit) => chit.textContent);
      expect(offered.some((text) => text.includes("Oriental Avenue"))).toBe(false);
      expect(offered.some((text) => text.includes("Robo"))).toBe(false);
    });

    it("offers the other human's estate, and says whose it is", async () => {
      // MON-204 is a real rule: Dan may build while waiting for his turn. Taking that away would make
      // the UI quietly narrower than the engine.
      await openTable();
      await waitFor(() => {
        expect(buildChits()).toHaveLength(2);
      });
      const dans = buildChits().find((chit) => chit.textContent.includes("Dan"));
      expect(dans).toBeDefined();
      expect(dans).toHaveTextContent("Dan · Baltic Avenue");
    });

    it("leaves the current player's own street unlabelled", async () => {
      await openTable();
      await waitFor(() => {
        expect(buildChits()).toHaveLength(2);
      });
      const own = buildChits().find((chit) => chit.textContent.includes("Mediterranean"));
      expect(own).toBeDefined();
      expect(own?.textContent).not.toContain("Ruti");
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

  it("carries the mute switch and the save button in the chrome (MON-704, MON-706)", async () => {
    // A wiring test, in the mounted app rather than per component. Both controls are tested on their
    // own; what this catches is the way they actually break — a hook or a component that exists, is
    // green in isolation, and was never placed on a screen.
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));
    await screen.findByTestId("board-grid");

    expect(screen.getByTestId("mute-sound")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("save-game")).toBeEnabled();
  });

  it("plays a cue for an event that arrives over the socket (MON-706)", async () => {
    // The one thing `useSoundCues.test.tsx` cannot show: that `GameScreen` actually calls it. The
    // hook is exercised through the real composition here, with the browser's audio API absent — so
    // what is asserted is that a cue reaching a jsdom with no `AudioContext` is silent rather than a
    // crash, which is the environment the whole test suite runs in and half of CI too.
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));
    await screen.findByTestId("board-grid");

    expect(() => {
      act(() => {
        sockets[0]?.onmessage?.({
          data: JSON.stringify({
            seq: 1,
            event: {
              type: "dice_rolled",
              player: 0,
              first: 2,
              second: 1,
              total: 3,
              doubles_streak: 0,
              purpose: "move",
            },
          }),
        });
      });
    }).not.toThrow();
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
    expect(cash).toEqual(["$50", "$125"]);

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

  it("offers a retry on a failed first fetch, and asks the server again (MON-708)", async () => {
    // Until MON-708 the only way out of this screen was "New game", which *abandons* the game the
    // URL is pointing at — a dead end that looks like a decision. The game is on the server and this
    // client simply has not got it yet, so asking again is exactly the right thing to try.
    openGameUrl("g1");
    // A 404, for the reason above: `useGame` retries a 5xx twice, and this test is about the button
    // rather than about the backoff.
    const edge = makeEdge({
      "GET /api/boards": ok(BOARDS),
      "GET /api/rulesets": ok(RULESETS),
      "GET /api/games/g1": refusal(404, "error.game_not_found"),
    });
    renderApp(edge);

    await screen.findByTestId("game-error");
    const before = edge.calls.filter((call) => call.path === "/api/games/g1").length;

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(edge.calls.filter((call) => call.path === "/api/games/g1").length).toBeGreaterThan(
        before,
      );
    });
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
   * Handing the dice on after a purchase, asserted over the mounted app.
   *
   * `autoEndTurn.test.ts` owns the decision, which is pure and has a unit test per branch. What it
   * cannot own is the *wire*, and the wire is where this feature can fail while every unit test
   * stays green: the effect has to see a committed event log, take the `end_turn` **out of the
   * engine's own list**, and post it once. So the fixture is a whole game and the assertion is on
   * what reached the server.
   *
   * The two tests are a pair on purpose. The first proves a turn ends by itself; the second proves
   * it does *not* when the engine did not offer `end_turn` — which is the doubles case, and the one
   * a "helpful" doubles check in the client would get subtly wrong. Neither test knows what doubles
   * are, which is the point: the client cannot know, and does not.
   */
  describe("ending a turn the player has finished with", () => {
    const BOUGHT = loggedEvent(7, {
      type: "property_acquired",
      player: 0,
      tile: 1,
      price: 60,
      via: "purchase",
    });

    const BUY: Command = { kind: "buy_property", player: 0 };

    /**
     * A game standing on an unowned square, whose purchase returns `next`.
     *
     * The purchase is *driven*, not loaded: the test clicks the chit, the POST answers with the view
     * the engine produced, and the effect sees the log the way a player would make it. Handing the
     * app a finished purchase in its first GET would test a reload instead, and a reload is not what
     * "buying ends your turn" is about.
     */
    function buying(next: GameView): Edge {
      return makeEdge({
        "GET /api/boards": ok(BOARDS),
        "GET /api/rulesets": ok(RULESETS),
        "GET /api/games/g1": ok(gameView({ phase: "awaiting_purchase_decision" }, [BUY])),
        // First POST is the purchase; any further one is the turn ending, and the same view answers
        // both — what matters is which commands were *sent*.
        "POST /api/games/g1/commands": ok(next),
      });
    }

    async function buy(): Promise<void> {
      await userEvent.click(await screen.findByRole("button", { name: "Buy this square" }));
    }

    /** The commands that reached the server, unwrapped from the request envelope. */
    function commandsPosted(edge: Edge): readonly unknown[] {
      return edge.calls
        .filter((call) => call.method === "POST" && call.path.endsWith("/commands"))
        .map((call) => (call.body as { command: unknown }).command);
    }

    it("posts end_turn itself once the purchase is in the log", async () => {
      const edge = buying(gameView({ phase: "awaiting_end_turn" }, [END_TURN], [BOUGHT]));
      openGameUrl("g1");
      renderApp(edge);
      await screen.findByTestId("board-grid");
      await buy();

      await waitFor(() => {
        expect(commandsPosted(edge)).toEqual([
          { kind: "buy_property", player: 0 },
          { kind: "end_turn", player: 0 },
        ]);
      });
    });

    it("posts it exactly once, however many times the view is committed again", async () => {
      // The idempotence guard is a `seq` the effect remembers. Without it, every refetch of a view
      // whose log still contains the purchase would end the turn again — on somebody else's turn.
      const edge = buying(gameView({ phase: "awaiting_end_turn" }, [END_TURN], [BOUGHT]));
      openGameUrl("g1");
      renderApp(edge);
      await screen.findByTestId("board-grid");
      await buy();
      await waitFor(() => {
        expect(commandsPosted(edge)).toHaveLength(2);
      });

      // The purchase, arriving *again* over the socket — a reconnect's backlog, which is the exact
      // shape that would end a turn twice if the effect keyed on "there is a purchase in the log"
      // rather than on which one it has already acted on.
      act(() => {
        sockets[0]?.onmessage?.({ data: JSON.stringify(BOUGHT) });
      });
      // A later, harmless frame gives the effect a full commit to misbehave in, and gives this test
      // something observable to wait for instead of a sleep.
      act(() => {
        sockets[0]?.onmessage?.({
          data: JSON.stringify(
            loggedEvent(BOUGHT.seq + 1, { type: "turn_started", player: 1, turn_number: 2 }),
          ),
        });
      });
      await waitFor(() => {
        expect(screen.getByRole("region", { name: "What's happened" }).textContent).toContain(
          "Turn 2",
        );
      });

      expect(commandsPosted(edge)).toHaveLength(2);
    });

    it("sends nothing when the engine did not offer end_turn — the doubles case", async () => {
      // Same purchase, same log; the engine came back at `awaiting_roll` because the move roll was
      // doubles, so `end_turn` is simply not in the list. The client never learns why.
      const edge = buying(gameView({ phase: "awaiting_roll" }, [ROLL], [BOUGHT]));
      openGameUrl("g1");
      renderApp(edge);
      await screen.findByTestId("board-grid");
      await buy();

      // Positive first: the purchase itself went, and the app is showing the game it produced.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Roll the dice" })).toBeInTheDocument();
      });
      expect(commandsPosted(edge)).toEqual([{ kind: "buy_property", player: 0 }]);
    });

    it("leaves the turn alone when the player has switched the behaviour off", async () => {
      globalThis.localStorage.setItem(AUTO_END_TURN_STORAGE_KEY, "false");
      forgetCachedAutoEndTurn();
      const edge = buying(gameView({ phase: "awaiting_end_turn" }, [END_TURN], [BOUGHT]));
      openGameUrl("g1");
      renderApp(edge);
      await screen.findByTestId("board-grid");
      await buy();

      // The button the player is now expected to press is on screen, and it is the only thing that
      // can send the command.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "End turn" })).toBeInTheDocument();
      });
      expect(commandsPosted(edge)).toEqual([{ kind: "buy_property", player: 0 }]);
    });
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
