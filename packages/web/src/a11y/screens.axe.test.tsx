/**
 * axe over **every screen and state**, in both languages and both rule sets (MON-703).
 *
 * ## Why a sweep, when nine component tests already run axe
 *
 * Because the nine run on *fragments*, and three of the four things axe is good at are properties of
 * a page rather than of a component:
 *
 * 1. **Landmarks.** `region` — "all content sits inside a landmark" — cannot be asked of a fragment
 *    at all, which is why `test/axe.ts` disables it. It is switched back on here, through
 *    {@link expectAxeCleanScreen}, so the product finally has an assertion that its content is inside
 *    `<main>`, `<header>` and `<aside>` rather than loose in a `<div>`.
 * 2. **Duplicate ids and orphaned `aria-labelledby`.** Two components are each innocent; the
 *    composition that mounts both is where an id collides and a label points at nothing. The dossier
 *    appears three times over on a screen with a pinned tray, which is the shape this catches.
 * 3. **Dialogs.** A modal's accessible name, its `aria-modal`, and the fact that the screen behind it
 *    has not been left with two `role="dialog"`s.
 *
 * The sweep runs against `document.body`, not a render container, so a portalled dialog and the
 * Announcer's two live regions are inside the audit rather than beside it.
 *
 * ## Both locales, and why that is not paranoia
 *
 * `missingKeyHandler` throws under test, so rendering a whole screen in Hebrew is simultaneously an
 * axe run and a catalogue check: any control whose accessible name comes from a key with no Hebrew
 * fails here by exception rather than by looking odd to a Hebrew reader. `tests/test_locale_parity.py`
 * checks the catalogues against each other; this checks that the screens only ask for keys that are
 * in them.
 *
 * ## What this file deliberately does not do
 *
 * It asserts nothing about colour. jsdom computes none, so `color-contrast` is off and the ratios are
 * arithmetic in `theme/contrast.test.ts`. It asserts nothing about box sizes either: the 44 px floor
 * needs a layout engine and lives in `e2e/targets.spec.ts` and `e2e/kids.spec.ts`.
 */

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Command, GameStateView, GameView, RentQuote } from "@/api";
import { useUiStore } from "@/game";
import { applyLocale, type Locale } from "@/i18n";
import {
  BOARDS,
  gameEdge,
  gameView,
  makeEdge,
  ok,
  openGameUrl,
  refusal,
  renderApp,
  RULESETS,
  SHORT_LOG,
  sockets,
} from "@/test/appHarness";
import { expectAxeCleanScreen } from "@/test/axe";
import { KIDS_RULESET } from "@/test/fixtures";

const ROLL: Command = { kind: "roll_dice", player: 0 };
const END_TURN: Command = { kind: "end_turn", player: 0 };
const BUY: Command = { kind: "buy_property", player: 0 };

/** Both languages, for the screens whose whole composition is worth re-auditing mirrored. */
const LOCALES: readonly Locale[] = ["en", "he"];

/**
 * Put the page in a language before it is rendered.
 *
 * Before rather than after, deliberately: a switch mid-test re-renders every component and an axe
 * run that raced the re-render would audit a half-translated tree. `applyLocale` writes `lang` and
 * `dir` on `<html>`, which is what the logical-CSS layout is keyed off, so this is the same state a
 * player who chose Hebrew is in.
 */
async function inLocale(locale: Locale): Promise<void> {
  await act(async () => {
    applyLocale(locale);
    await Promise.resolve();
  });
}

beforeEach(() => {
  sockets.length = 0;
  globalThis.history.pushState({}, "", "/");
  useUiStore.setState({
    selectedTile: null,
    selectedPlayer: null,
    panel: null,
    pinnedPlayers: [],
  });
});

afterEach(async () => {
  // English is what the rest of the suite asserts in, and i18next is a module-level singleton — a
  // Hebrew case that did not put it back would hand the next file a Hebrew page.
  await inLocale("en");
});

describe("axe — the setup screen", () => {
  it.each(LOCALES)("is clean with both lists loaded, in %s", async (locale) => {
    await inLocale(locale);
    renderApp(makeEdge({ "GET /api/boards": ok(BOARDS), "GET /api/rulesets": ok(RULESETS) }));
    // Two seat rows means the whole form is up: the board picker, the rule-set picker, the locale
    // radios and the two name fields all render together off the same two lists.
    await waitFor(() => {
      expect(screen.getAllByRole("textbox").length).toBeGreaterThan(1);
    });

    await expectAxeCleanScreen(document.body);
  });

  it("is clean while the two lists are in flight", async () => {
    renderApp(makeEdge({}, { hang: true }));
    expect(screen.getByTestId("setup-loading")).toBeInTheDocument();

    await expectAxeCleanScreen(document.body);
  });

  it("is clean on the empty state, with the load affordance beside it", async () => {
    renderApp(makeEdge({ "GET /api/boards": ok([]), "GET /api/rulesets": ok(RULESETS) }));
    await screen.findByTestId("setup-empty");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean on the error state, which takes focus", async () => {
    renderApp(
      makeEdge({
        "GET /api/boards": refusal(404, "error.game_not_found"),
        "GET /api/rulesets": ok(RULESETS),
      }),
    );
    await screen.findByTestId("setup-error");

    await expectAxeCleanScreen(document.body);
  });
});

describe("axe — the game screen", () => {
  /** A universal game, with enough offered that the bar, the hint and the log all have content. */
  function universal(overrides: Partial<GameStateView> = {}): GameView {
    return gameView(overrides, [ROLL, BUY, END_TURN]);
  }

  async function openGame(view: GameView): Promise<void> {
    openGameUrl("g1");
    renderApp(gameEdge(view));
    await screen.findByTestId("board-grid");
  }

  it.each(LOCALES)("is clean under the universal rules, in %s", async (locale) => {
    await inLocale(locale);
    await openGame(universal());

    await expectAxeCleanScreen(document.body);
  });

  it.each(LOCALES)("is clean in Kids Mode, in %s", async (locale) => {
    // The kids screen is a different tree, not a restyled one: the hint is open, the turn banner is
    // prominent, and every chit carries the simpler wording. All three are name-bearing.
    await inLocale(locale);
    await openGame(gameView({ ruleset: KIDS_RULESET }, [ROLL, BUY, END_TURN]));
    expect(screen.getByTestId("hint-panel").dataset.prominent).toBe("true");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean while the first view is still in flight", async () => {
    openGameUrl("g1");
    renderApp(makeEdge({}, { hang: true }));
    await screen.findByTestId("game-loading");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean on a failed first fetch, retry and all", async () => {
    openGameUrl("g1");
    renderApp(
      makeEdge({
        "GET /api/boards": ok(BOARDS),
        "GET /api/rulesets": ok(RULESETS),
        "GET /api/games/g1": refusal(404, "error.game_not_found"),
      }),
    );
    await screen.findByTestId("game-error");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean with the reconnection note above the board", async () => {
    // The note is a sibling of `<main>` in the chrome, so it is exactly the kind of content a
    // landmark audit is for — and it only exists after a socket has dropped.
    await openGame(universal());
    act(() => {
      sockets[0]?.onopen?.({});
      sockets[0]?.onclose?.({ code: 1006, reason: "", wasClean: false });
    });
    await screen.findByTestId("connection-note");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean with a rejected command reported on screen", async () => {
    openGameUrl("g1");
    renderApp(
      makeEdge({
        "GET /api/boards": ok(BOARDS),
        "GET /api/rulesets": ok(RULESETS),
        "GET /api/games/g1": ok(universal()),
        "POST /api/games/g1/commands": refusal(422, "error.not_your_turn"),
      }),
    );
    await screen.findByTestId("board-grid");
    await userEvent.click(screen.getByRole("button", { name: /Roll the dice/ }));
    await screen.findByText("It isn't your turn yet.");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean with a square open and its rent explained", async () => {
    const quotes = Array.from({ length: 40 }, () => null as RentQuote | null);
    quotes[1] = {
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
    };
    await openGame(universal({ rent_quotes: quotes }));
    act(() => {
      useUiStore.setState({ selectedTile: 1 });
    });
    await screen.findByTestId("square-rent");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean with the hint unfolded under the full rules", async () => {
    await openGame(universal());
    await userEvent.click(screen.getByText("Show a hint"));
    await waitFor(() => {
      expect(screen.getByTestId("hint-panel")).toHaveAttribute("open");
    });

    await expectAxeCleanScreen(document.body);
  });
});

describe("axe — the panels that open over the game", () => {
  const AUCTION = {
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

  const TRADE = {
    kind: "trade" as const,
    resume: "awaiting_roll" as const,
    offer: {
      proposer: 0,
      recipient: 1,
      give: { cash: 50, tiles: [1], jail_cards: [] },
      receive: { cash: 125, tiles: [3], jail_cards: [] },
    },
  };

  it.each(LOCALES)("is clean with the auction panel up, in %s", async (locale) => {
    await inLocale(locale);
    openGameUrl("g1");
    renderApp(
      gameEdge(
        gameView({ phase: "auction", interrupts: [AUCTION] }, [
          { kind: "place_bid", player: 0, amount: 10 },
          { kind: "withdraw_from_auction", player: 0 },
        ]),
      ),
    );
    await screen.findByRole("dialog");

    await expectAxeCleanScreen(document.body);
  });

  it.each(LOCALES)("is clean reviewing an offer, in %s", async (locale) => {
    await inLocale(locale);
    openGameUrl("g1");
    renderApp(gameEdge(gameView({ phase: "trade_review", interrupts: [TRADE] })));
    await screen.findByTestId("trade-accept");

    await expectAxeCleanScreen(document.body);
  });

  it.each(LOCALES)("is clean drafting an offer, in %s", async (locale) => {
    // The draft is the densest form in the product — two trays of checkboxes, two cash steppers and
    // a live validation note — and every one of those needs a name.
    await inLocale(locale);
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));
    await screen.findByTestId("board-grid");
    act(() => {
      useUiStore.setState({ panel: "trade" });
    });
    await screen.findByRole("dialog");

    await expectAxeCleanScreen(document.body);
  });

  it.each(LOCALES)("is clean with two dossiers pinned in the tray, in %s", async (locale) => {
    // Three copies of `<PlayerDossier>` on one page — the aside's and the tray's two — which is the
    // composition where a `useId`-free duplicate id or a stray `aria-labelledby` would show up.
    await inLocale(locale);
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL])));
    await screen.findByTestId("board-grid");
    act(() => {
      useUiStore.setState({ pinnedPlayers: [0, 1] });
    });
    await screen.findByTestId("compare-tray");

    await expectAxeCleanScreen(document.body);
  });

  it.each(LOCALES)("is clean with the replay viewer open, in %s", async (locale) => {
    // With a log in it. `replay.empty` is a different tree with no slider and no `<ReplayBoard>`, so
    // auditing the empty case would leave the controls — the newest surface in the product —
    // unaudited. The empty case has its own axe test in `ReplayPanel.test.tsx`.
    await inLocale(locale);
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL], SHORT_LOG)));
    await screen.findByTestId("board-grid");
    await userEvent.click(screen.getByTestId("open-replay"));
    await screen.findByTestId("replay-controls");

    await expectAxeCleanScreen(document.body);
  });

  it("is clean with the event log carrying sentences", async () => {
    // An empty ledger renders `<EmptyState>`; a populated one renders a scrollable list, which is the
    // `scrollable-region-focusable` case `EventLog.tsx` cites by name.
    openGameUrl("g1");
    renderApp(gameEdge(gameView({}, [ROLL], SHORT_LOG)));
    await screen.findByTestId("board-grid");
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "What's happened" })).toHaveTextContent(/\S/);
    });

    await expectAxeCleanScreen(document.body);
  });
});
