/**
 * The card held up on the board (MON-709).
 *
 * ## The falsifiers
 *
 * Three claims here are the kind that look satisfied in a screenshot and are not:
 *
 * - **The figure is the engine's.** A component that worked out "collect $200" from the card's key
 *   would look perfect on every card in the deck and be wrong the first time the engine's own figure
 *   differed. So the test below feeds a `delta` that the card's text flatly contradicts and asserts
 *   the *number* is the one shown. Compute the amount here and it goes red.
 * - **Nothing waits for it.** Non-blocking is a structural property, not a feeling, so it is tested
 *   structurally: the layer over the board must not swallow pointer events, and the card must not be
 *   a modal — no `role="dialog"`, no focus trap, nothing `aria-modal`.
 * - **The deck is legible without colour.** Asserted as three separate channels — the deck's name in
 *   words, a glyph, and a border style — because "it is blue" is what this project does not accept
 *   (spec §5.4). Delete any one of the three and one assertion fails.
 *
 * And the one that will matter later: with a stubbed Hebrew `cards` catalogue, the body must come out
 * Hebrew **with no change to this component**. That is the test that proves MON-506 is a catalogue
 * job rather than a code job.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RevealedCard } from "@/animation";
import { i18n } from "@/i18n";
import { stripIsolates } from "@/i18n/bidi";
import { expectAxeClean } from "@/test/axe";

import { CardReveal } from "./CardReveal";

const CARD: RevealedCard = {
  nonce: 1,
  player: 0,
  deck: "chance",
  cardId: "card.chance.advance_to_go",
  delta: null,
  balance: null,
};

function mount(
  card: Partial<RevealedCard> = {},
  extras: {
    readonly kids?: boolean;
    readonly onDismiss?: () => void;
    readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
  } = {},
): void {
  render(
    <CardReveal
      card={{ ...CARD, ...card }}
      playerName="Ruti"
      kids={extras.kids ?? false}
      onDismiss={extras.onDismiss ?? ((): void => undefined)}
      {...(extras.returnFocusRef === undefined ? {} : { returnFocusRef: extras.returnFocusRef })}
    />,
  );
}

function body(): HTMLElement {
  return screen.getByTestId("card-reveal-text");
}

afterEach(async () => {
  // The suite runs in English (`src/test/setup.ts`). The Hebrew cases below change that and have to
  // hand it back, and they add a resource bundle that must not leak into the next test either.
  if (i18n.language !== "en") {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  }
});

describe("what the card says", () => {
  it("shows the engine's own card text, looked up by the key the event carried", () => {
    mount();
    // `cards.en.json` owns the sentence; the key is `CardDrawn.card_id` verbatim (ADR-003).
    expect(body().textContent).toBe(i18n.t("cards:card.chance.advance_to_go"));
  });

  it("names the gap rather than printing a raw key for a card the catalogue has not got", () => {
    // `card_id` comes from the engine and `missingKeyHandler` throws under test by design, so an
    // unguarded lookup here would take the board down on a deck that grew a card.
    mount({ cardId: "card.chance.not_in_the_catalogue_yet" });
    expect(body()).toHaveTextContent("no text in the catalogue yet");
  });

  it("shows the figure the events stated, not one it worked out from the card", () => {
    // "Advance to GO" is a $200 card in every edition ever printed. The engine said 175, so the card
    // says 175: this component does no arithmetic and knows what no card does.
    mount({ delta: 175, balance: 1675 });
    expect(stripIsolates(screen.getByTestId("card-reveal-figure").textContent)).toContain("175");
    expect(stripIsolates(screen.getByTestId("card-reveal-balance").textContent)).toContain("1675");
  });

  it("picks the verb from the sign of the figure", () => {
    mount({ delta: -50, balance: 1450 });
    expect(screen.getByTestId("card-reveal-figure")).toHaveTextContent(/pay/i);
  });

  it("shows no figure at all for a card that moved no money", () => {
    // Not "0". A card that only moves a piece gets no money line.
    mount({ delta: null, balance: null });
    expect(screen.queryByTestId("card-reveal-figure")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-reveal-balance")).not.toBeInTheDocument();
  });

  it("names the seat that drew it — with six seats, that is half the sentence", () => {
    mount();
    expect(screen.getByTestId("card-reveal")).toHaveAccessibleName(/Ruti/);
  });

  it("uses the simpler wording in a kids game", () => {
    mount({ delta: 20, balance: 1520 }, { kids: true });
    // `kids.card_reveal.gained` is "You get {{amount}}!"; the ordinary key says "You collect".
    expect(screen.getByTestId("card-reveal-figure")).toHaveTextContent(/get/i);
    expect(screen.getByTestId("card-reveal-dismiss")).toHaveTextContent("Got it");
  });
});

describe("telling the two decks apart", () => {
  it("names the deck in words, so colour is never the only channel", () => {
    mount({ deck: "community_chest" });
    expect(screen.getByTestId("card-reveal-deck").textContent).toBe(i18n.t("deck.community_chest"));
  });

  it("gives each deck its own glyph", () => {
    // Compared as outlines rather than as names: the point of the second channel is that the two
    // decks look different in greyscale, and two `<Icon>`s that happened to resolve to one path
    // would satisfy any assertion about which icon was *asked* for.
    mount({ deck: "chance" });
    mount({ deck: "community_chest" });
    const [chance, chest] = screen.getAllByTestId("card-reveal");

    const outline = (card: HTMLElement | undefined): string | null | undefined =>
      card?.querySelector("svg path")?.getAttribute("d");

    expect(outline(chance)).toBeTruthy();
    expect(outline(chance)).not.toBe(outline(chest));
  });

  it("gives each deck its own edge, which survives greyscale", () => {
    mount({ deck: "chance" });
    expect(screen.getByTestId("card-reveal").className).toContain("border-dashed");

    mount({ deck: "community_chest" });
    expect(screen.getAllByTestId("card-reveal")[1]?.className).toContain("border-double");
  });

  it("marks the deck as data, so a test — and a stylesheet — can see it without reading a colour", () => {
    mount({ deck: "community_chest" });
    expect(screen.getByTestId("card-reveal")).toHaveAttribute("data-deck", "community_chest");
  });
});

describe("nothing waits for the card", () => {
  it("lets every click through to the board underneath, except on the card itself", () => {
    mount();
    // The structural half of "non-blocking": the layer covers the board so the card can be centred
    // on it, and it must not be the thing that eats a click on a square.
    expect(screen.getByTestId("card-reveal-layer").className).toContain("pointer-events-none");
    expect(screen.getByTestId("card-reveal").className).toContain("pointer-events-auto");
  });

  it("is not a modal, and traps nothing", () => {
    mount();
    const card = screen.getByTestId("card-reveal");
    expect(card).toHaveAttribute("role", "group");
    expect(card).not.toHaveAttribute("aria-modal");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says nothing in a live region of its own — the Announcer already said it", () => {
    // Two channels narrating one draw is the same sentence twice (G-D1/G-54).
    mount();
    expect(screen.getByTestId("card-reveal-layer").querySelector("[aria-live]")).toBeNull();
  });

  it("is axe clean", async () => {
    mount({ delta: -50, balance: 1450 });
    await expectAxeClean(screen.getByTestId("card-reveal-layer"));
  });
});

describe("putting the card down", () => {
  it("dismisses on the button, and the caller decides what that means", async () => {
    const onDismiss = vi.fn();
    mount({}, { onDismiss });

    await userEvent.click(screen.getByTestId("card-reveal-dismiss"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape, so a keyboard reader need not hunt for the button", async () => {
    const onDismiss = vi.fn();
    mount({}, { onDismiss });
    screen.getByTestId("card-reveal-dismiss").focus();

    await userEvent.keyboard("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hands the focus back when it is dismissed from the keyboard", async () => {
    const landing = document.createElement("button");
    landing.textContent = "skip";
    document.body.append(landing);
    const returnFocusRef = createRef<HTMLElement>();
    returnFocusRef.current = landing;

    mount({}, { returnFocusRef });
    screen.getByTestId("card-reveal-dismiss").focus();
    await userEvent.keyboard("{Enter}");

    expect(document.activeElement).toBe(landing);
    landing.remove();
  });

  it("hands the focus back when the card times out with the focus inside it", () => {
    // The exit that is easy to forget: the queue's own beat ends, this unmounts, and a focused
    // control disappears — dropping the focus onto `<body>` in the middle of a turn.
    const landing = document.createElement("button");
    document.body.append(landing);
    const returnFocusRef = createRef<HTMLElement>();
    returnFocusRef.current = landing;

    const view = render(
      <CardReveal
        card={CARD}
        playerName="Ruti"
        kids={false}
        onDismiss={(): void => undefined}
        returnFocusRef={returnFocusRef}
      />,
    );
    screen.getByTestId("card-reveal-dismiss").focus();
    view.unmount();

    expect(document.activeElement).toBe(landing);
    landing.remove();
  });

  it("leaves the focus alone when the card times out with the focus elsewhere", () => {
    // A player who never looked at the card was doing something else. Stealing the focus to a skip
    // button mid-sentence would be worse than the bug above.
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    const landing = document.createElement("button");
    document.body.append(landing);
    const returnFocusRef = createRef<HTMLElement>();
    returnFocusRef.current = landing;

    const view = render(
      <CardReveal
        card={CARD}
        playerName="Ruti"
        kids={false}
        onDismiss={(): void => undefined}
        returnFocusRef={returnFocusRef}
      />,
    );
    elsewhere.focus();
    view.unmount();

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    landing.remove();
  });
});

describe("a Hebrew game", () => {
  const KEY = "card.chance.advance_to_go";

  async function inHebrew(): Promise<void> {
    await act(async () => {
      await i18n.changeLanguage("he");
    });
  }

  it("shows the card in Hebrew, from the Hebrew catalogue (MON-506)", async () => {
    await inHebrew();
    mount();

    expect(body().textContent).toBe(i18n.getResource("he", "cards", KEY));
    // Not the English one. Until MON-506 both languages resolved to the same resource, so an
    // assertion that only checked "some text is rendered" passed throughout the gap.
    expect(body().textContent).not.toBe(i18n.getResource("en", "cards", KEY));
  });

  it("declares no language of its own, because the body is now the page's language", async () => {
    // `lang`/`dir` exist to mark a body that disagrees with the page. A Hebrew card in a Hebrew
    // page does not, so the markup goes quiet — the same code, a different answer, which is what
    // `cardSurface.ts` was written to make possible.
    await inHebrew();
    mount();

    expect(body()).not.toHaveAttribute("lang");
    expect(body()).not.toHaveAttribute("dir");
  });

  it("still marks a card the Hebrew deck has not got, which is the safety net", async () => {
    /*
      The gap MON-506 closed can reopen one card at a time: a card is added to `decks.py` and to
      `cards.en.json`, and the Hebrew entry is forgotten. i18next then falls back to English — the
      game keeps working, and the body is genuinely English inside an RTL page, which is exactly
      what `lang="en" dir="ltr"` exists for.

      Simulated by handing `he` a catalogue with that one card missing, which is the state the
      forgetful commit would produce. `tests/test_locale_parity.py` fails that commit; this says the
      rendering degrades honestly even if the catalogue does not.

      Note this is *not* the same as an id neither deck has — that one resolves to the
      "no text in the catalogue yet" sentence, which is itself Hebrew, and is covered above.
    */
    await inHebrew();
    const full = i18n.getResourceBundle("he", "cards") as {
      card: { chance: Record<string, string> };
    };
    // Everything but this card, which is the shape the forgetful commit leaves behind.
    const rest = Object.fromEntries(
      Object.entries(full.card.chance).filter(([leaf]) => leaf !== KEY.split(".").pop()),
    );
    i18n.removeResourceBundle("he", "cards");
    i18n.addResourceBundle(
      "he",
      "cards",
      { ...full, card: { ...full.card, chance: rest } },
      true,
      true,
    );
    try {
      mount();

      expect(body().textContent).toBe(i18n.getResource("en", "cards", KEY));
      expect(body()).toHaveAttribute("lang", "en");
      expect(body()).toHaveAttribute("dir", "ltr");
    } finally {
      i18n.removeResourceBundle("he", "cards");
      i18n.addResourceBundle("he", "cards", full, true, true);
    }
    expect(i18n.getResource("he", "cards", KEY)).toBeTruthy();
  });
});
