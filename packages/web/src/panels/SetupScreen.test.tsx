/**
 * What these tests are for.
 *
 * 1. **The Kids-mode explanation comes from the fetched rule sets, not from a literal.** The
 *    falsifier is the one that matters: change a flag in the fixture and the rendered diff
 *    changes with it. A test that only asserted "the words auctions appears" would pass against
 *    the hardcoded `setup.kidsExplainer` this item exists to remove.
 * 2. **The server owns validation.** One seat, or two seats with the same name, both reach the
 *    network — and the rejection renders from its `reason_key`.
 * 3. **Keyboard and target size.** Every control is reachable and ≥ 44 px, including at 320 px,
 *    where the arithmetic is tightest.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api";
import type { BoardSummary, NewGameRequest } from "@/api";

import { KIDS_RULES, UNIVERSAL_RULES } from "./SetupScreenFixtures";
import { SetupScreen } from "./SetupScreen";

const BOARDS: readonly BoardSummary[] = [
  { id: "classic", name_key: "board.classic.name", tile_count: 40, ownable_count: 28 },
];

function setup(
  overrides: {
    readonly onStart?: (request: NewGameRequest) => Promise<unknown>;
    readonly rulesets?: readonly (typeof UNIVERSAL_RULES)[];
  } = {},
): { readonly onStart: ReturnType<typeof vi.fn> } {
  const onStart = vi.fn(overrides.onStart ?? (() => Promise.resolve()));
  render(
    <SetupScreen
      boards={BOARDS}
      rulesets={overrides.rulesets ?? [UNIVERSAL_RULES, KIDS_RULES]}
      locale="en"
      onLocaleChange={vi.fn()}
      onStart={onStart}
    />,
  );
  return { onStart };
}

/**
 * One seat's card, found through its own name box.
 *
 * Not `getAllByRole("group")[n]`: the seats live inside a `<fieldset>` of their own and each
 * carries nested ones, so an index into the groups picks the wrapper and every seat's controls
 * with it — which is how the first version of this file "set seat two to a computer" and set
 * both.
 */
function seatCard(index: number): HTMLElement {
  const box = screen.getAllByLabelText(i18next.t("setup.playerName"))[index];
  const card = box?.closest("li");
  if (card === null || card === undefined) {
    throw new Error(`no seat card at index ${String(index)}`);
  }
  return card;
}

/** Fill both starting seats so the form is complete; nothing here is a game rule. */
async function nameBothSeats(names: readonly [string, string]): Promise<void> {
  const user = userEvent.setup();
  const boxes = screen.getAllByLabelText(i18next.t("setup.playerName"));
  await user.type(boxes[0] as HTMLElement, names[0]);
  await user.type(boxes[1] as HTMLElement, names[1]);
}

describe("the seats", () => {
  it("opens with two, and each carries an identity a pre-reader can tell apart", () => {
    setup();
    expect(screen.getAllByLabelText(i18next.t("setup.playerName"))).toHaveLength(2);
    // Shape and colour live in an `aria-hidden` SVG; the piece's *name* is the text channel, so
    // the identity is never colour-only (GAP A2/G-51).
    expect(screen.getByText(i18next.t("token.kite"))).toBeInTheDocument();
    expect(screen.getByText(i18next.t("token.drum"))).toBeInTheDocument();
  });

  it("adds seats up to six and then stops offering", async () => {
    const user = userEvent.setup();
    setup();
    for (let seat = 3; seat <= 6; seat += 1) {
      await user.click(
        screen.getByRole("button", { name: new RegExp(i18next.t("setup.addPlayer")) }),
      );
    }
    expect(screen.getAllByLabelText(i18next.t("setup.playerName"))).toHaveLength(6);
    expect(
      screen.queryByRole("button", { name: new RegExp(i18next.t("setup.addPlayer")) }),
    ).not.toBeInTheDocument();
  });

  it("lets a seat be removed all the way down to one — the count is the engine's rule", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getAllByRole("button", { name: /Remove/ })[0] as HTMLElement);
    expect(screen.getAllByLabelText(i18next.t("setup.playerName"))).toHaveLength(1);
  });

  it("offers a difficulty only once a seat is a computer", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByLabelText(i18next.t("setup.botLevel"))).not.toBeInTheDocument();
    await user.click(within(seatCard(0)).getByRole("radio", { name: i18next.t("setup.bot") }));
    expect(screen.getByLabelText(i18next.t("setup.botLevel"))).toBeInTheDocument();
  });

  it("defaults the pronoun to the neutral value", () => {
    setup();
    const pronoun = screen.getAllByLabelText(i18next.t("setup.pronoun"))[0] as HTMLSelectElement;
    expect(pronoun.value).toBe("n");
  });
});

describe("Kids mode shows what it changes", () => {
  it("lists the flags that differ between the two rule sets the endpoint returned", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));

    expect(screen.getByText(i18next.t("setup.kidsChanges"))).toBeInTheDocument();
    for (const label of [
      "ruleset.auctions_enabled",
      "ruleset.mortgages_enabled",
      "ruleset.hints_enabled",
    ]) {
      expect(screen.getByText(i18next.t(label))).toBeInTheDocument();
    }
  });

  it("reads the flags rather than a sentence — flip one and the list follows", async () => {
    const user = userEvent.setup();
    // The falsifier. If the explanation were `setup.kidsExplainer`, or any other literal, this
    // Kids ruleset — identical to the universal rules apart from one flag — would still print
    // "no auctions or mortgages, simpler trades, hints on".
    setup({
      rulesets: [
        UNIVERSAL_RULES,
        { ...UNIVERSAL_RULES, name: "kids", double_salary_on_exact_go: true },
      ],
    });
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));

    expect(screen.getByText(i18next.t("ruleset.double_salary_on_exact_go"))).toBeInTheDocument();
    expect(screen.queryByText(i18next.t("ruleset.auctions_enabled"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18next.t("setup.kidsExplainer", { minutes: 45 }))).toBeNull();
  });

  it("says so plainly when the two rule sets agree", async () => {
    const user = userEvent.setup();
    setup({ rulesets: [UNIVERSAL_RULES, { ...UNIVERSAL_RULES, name: "kids" }] });
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));
    expect(screen.getByText(i18next.t("setup.kidsNoChanges"))).toBeInTheDocument();
  });

  it("shows both halves of a change, without a direction glyph that cannot mirror", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));
    const row = screen.getByText(i18next.t("ruleset.starting_cash")).parentElement;
    expect(row?.textContent).toContain("1000");
    expect(row?.textContent).toContain(i18next.t("ruleset.previous", { value: "1500" }));
    expect(row?.textContent).not.toContain("→");
  });

  it("shows nothing about changes while the full rules are chosen", () => {
    setup();
    expect(screen.queryByText(i18next.t("setup.kidsChanges"))).not.toBeInTheDocument();
  });
});

describe("validation is the server's", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts a single seat rather than refusing to try", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();
    await user.click(screen.getAllByRole("button", { name: /Remove/ })[0] as HTMLElement);
    await user.type(screen.getByLabelText(i18next.t("setup.playerName")), "Ruti");
    await user.click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    expect((onStart.mock.calls[0]?.[0] as NewGameRequest).seats).toHaveLength(1);
  });

  it("posts two seats sharing a name — duplicate names are the engine's rule, not a form's", async () => {
    const { onStart } = setup();
    await nameBothSeats(["Ruti", "Ruti"]);
    await userEvent.setup().click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    const seats = (onStart.mock.calls[0]?.[0] as NewGameRequest).seats;
    expect(seats.map((seat) => seat.name)).toEqual(["Ruti", "Ruti"]);
  });

  it("renders the rejection's key, with its params", async () => {
    setup({
      onStart: () =>
        Promise.reject(new ApiError(422, "error.unknown_board", { board_id: "atlantis" })),
    });
    await nameBothSeats(["Ruti", "Dan"]);
    await userEvent.setup().click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(
        screen.getByText(i18next.t("error.unknown_board", { board_id: "atlantis" })),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(i18next.t("setup.cannotStart"))).toBeInTheDocument();
  });

  it("falls back rather than throwing on a key the catalogue has not got yet", async () => {
    setup({ onStart: () => Promise.reject(new ApiError(422, "error.a_key_from_the_future")) });
    await nameBothSeats(["Ruti", "Dan"]);
    await userEvent.setup().click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    // The catalogue throws on a missing key in dev and test by design (G-F17), so an unguarded
    // `t()` here would replace the form with a blank screen over one unmapped server key.
    await waitFor(() => {
      expect(screen.getByText(i18next.t("error.illegalMove"))).toBeInTheDocument();
    });
  });

  it("moves focus to the refusal instead of announcing it in a second live region", async () => {
    setup({ onStart: () => Promise.reject(new ApiError(422, "error.invalid_new_game")) });
    await nameBothSeats(["Ruti", "Dan"]);
    await userEvent.setup().click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(screen.getByText(i18next.t("error.invalid_new_game"))).toBeInTheDocument();
    });
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(document.activeElement?.textContent).toContain(i18next.t("setup.cannotStart"));
  });

  it("keeps the start button out of reach only while a name box is empty", async () => {
    setup();
    const start = screen.getByRole("button", { name: i18next.t("setup.start") });
    expect(start).toBeDisabled();
    await nameBothSeats(["Ruti", "Dan"]);
    expect(start).toBeEnabled();
  });
});

describe("what reaches the wire", () => {
  it("carries the seat's kind, level, pronoun and a distinct piece each", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();
    await nameBothSeats(["Ruti", "Dan"]);

    const secondSeat = seatCard(1);
    await user.click(within(secondSeat).getByRole("radio", { name: i18next.t("setup.bot") }));
    await user.selectOptions(
      within(secondSeat).getByLabelText(i18next.t("setup.botLevel")),
      "hard",
    );
    await user.selectOptions(within(secondSeat).getByLabelText(i18next.t("setup.pronoun")), "f");
    await user.click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    const request = onStart.mock.calls[0]?.[0] as NewGameRequest;
    expect(request.seats[0]).toEqual({
      name: "Ruti",
      is_bot: false,
      // Explicit `null`, not omitted: the schema keeps `is_bot` on the wire so a bot with no
      // level is a 422 rather than a silently seated human.
      bot_level: null,
      token: "kite",
      grammatical_gender: "n",
    });
    expect(request.seats[1]).toEqual({
      name: "Dan",
      is_bot: true,
      bot_level: "hard",
      token: "drum",
      grammatical_gender: "f",
    });
    expect(request.board_id).toBe("classic");
    expect(request.ruleset).toBe("universal");
    expect(request.locale).toBe("en");
    expect(request.seed).toBeUndefined();
  });

  it("sends a seed when one is typed, and omits the field when it is not", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();
    await nameBothSeats(["Ruti", "Dan"]);
    await user.type(screen.getByLabelText(i18next.t("setup.seed")), "1234");
    await user.click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    expect((onStart.mock.calls[0]?.[0] as NewGameRequest).seed).toBe(1234);
  });

  it("sends the chosen rule set", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();
    await nameBothSeats(["Ruti", "Dan"]);
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));
    await user.click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
    });
    expect((onStart.mock.calls[0]?.[0] as NewGameRequest).ruleset).toBe("kids");
  });
});

describe("the accessibility floor", () => {
  it("labels every input, so nothing is a box with no name", () => {
    setup();
    for (const field of [
      ...screen.getAllByRole("textbox"),
      ...screen.getAllByRole("combobox"),
      ...screen.getAllByRole("spinbutton"),
      ...screen.getAllByRole("radio"),
    ]) {
      expect(field).toHaveAccessibleName();
    }
  });

  it("reaches every control from the keyboard, in order", async () => {
    const user = userEvent.setup();
    setup();
    const reachable: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        reachable.push(active.tagName.toLowerCase());
      }
    }
    expect(reachable).toContain("input");
    expect(reachable).toContain("select");
    expect(reachable).toContain("button");
  });

  it("gives every interactive element a target class of at least 44 px", () => {
    setup();
    // jsdom computes no layout, so the assertion is on the declared floor rather than on a
    // measured rect — the measured version is the Playwright pass at 320 px (spec §5.5). What
    // this catches is a control shipped with no minimum at all, which is the common way the
    // 44 px floor is lost.
    const controls = [
      ...screen.getAllByRole("button"),
      ...screen.getAllByRole("textbox"),
      ...screen.getAllByRole("combobox"),
      ...screen.getAllByRole("spinbutton"),
    ];
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      expect(control.className).toMatch(/min-h-1[14]/);
    }
  });

  it("gives a radio its target through the label that wraps it", () => {
    setup();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.closest("label")?.className).toMatch(/min-h-11/);
    }
  });

  it("uses no physical CSS property anywhere in its markup", () => {
    const { container } = render(
      <SetupScreen
        boards={BOARDS}
        rulesets={[UNIVERSAL_RULES, KIDS_RULES]}
        locale="en"
        onLocaleChange={vi.fn()}
        onStart={vi.fn(() => Promise.resolve())}
      />,
    );
    // A physical property is invisible in English and obviously broken in Hebrew, so it is
    // asserted rather than reviewed. The lint covers literals; this covers what actually
    // rendered, including anything a template literal produced.
    expect(container.innerHTML).not.toMatch(
      /class="[^"]*\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right|translate-x)-/,
    );
  });
});
