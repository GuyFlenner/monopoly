/**
 * What these tests are for.
 *
 * 1. **The Kids-mode explanation comes from the fetched rule sets, not from a literal.** The
 *    falsifier is the one that matters: change what the fixture marks and the rendered list changes
 *    with it. A test that only asserted "the word auctions appears" would pass against the
 *    hardcoded `setup.kids_explainer` this item exists to remove.
 *
 *    Since MON-417 the *marking* is the server's (`differs_from_universal`), so what is asserted
 *    here is that the screen renders exactly the marked flags and no others. Whether the server
 *    marks the right ones is `test_api.py`'s question — see `SetupScreenFixtures.ts`.
 * 2. **The server owns validation.** One seat, or two seats with the same name, both reach the
 *    network — and the rejection renders from its `reason_key`, which since MON-418 names the
 *    actual mistake rather than one coarse key for three of them.
 * 3. **Keyboard and target size.** Every control is reachable and ≥ 44 px, including at 320 px,
 *    where the arithmetic is tightest.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api";
import type { BoardSummary, NewGameRequest, RulesetView } from "@/api";

import {
  KIDS_VIEW,
  KIDS_VIEW_ONE_CHANGE,
  KIDS_VIEW_UNCHANGED,
  UNIVERSAL_VIEW,
} from "./SetupScreenFixtures";
import { SetupScreen } from "./SetupScreen";

const BOARDS: readonly BoardSummary[] = [
  {
    id: "classic",
    name_key: "board.classic.name",
    tile_count: 40,
    ownable_count: 28,
    catalogue_ready: true,
  },
];

function setup(
  overrides: {
    readonly onStart?: (request: NewGameRequest) => Promise<unknown>;
    readonly rulesets?: readonly RulesetView[];
  } = {},
): { readonly onStart: ReturnType<typeof vi.fn> } {
  const onStart = vi.fn(overrides.onStart ?? (() => Promise.resolve()));
  render(
    <SetupScreen
      boards={BOARDS}
      rulesets={overrides.rulesets ?? [UNIVERSAL_VIEW, KIDS_VIEW]}
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
  const box = screen.getAllByLabelText(i18next.t("setup.player_name"))[index];
  const card = box?.closest("li");
  if (card === null || card === undefined) {
    throw new Error(`no seat card at index ${String(index)}`);
  }
  return card;
}

/** Fill both starting seats so the form is complete; nothing here is a game rule. */
async function nameBothSeats(names: readonly [string, string]): Promise<void> {
  const user = userEvent.setup();
  const boxes = screen.getAllByLabelText(i18next.t("setup.player_name"));
  await user.type(boxes[0] as HTMLElement, names[0]);
  await user.type(boxes[1] as HTMLElement, names[1]);
}

describe("the seats", () => {
  it("opens with two, and each carries an identity a pre-reader can tell apart", () => {
    setup();
    expect(screen.getAllByLabelText(i18next.t("setup.player_name"))).toHaveLength(2);
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
        screen.getByRole("button", { name: new RegExp(i18next.t("setup.add_player")) }),
      );
    }
    expect(screen.getAllByLabelText(i18next.t("setup.player_name"))).toHaveLength(6);
    expect(
      screen.queryByRole("button", { name: new RegExp(i18next.t("setup.add_player")) }),
    ).not.toBeInTheDocument();
  });

  it("lets a seat be removed all the way down to one — the count is the engine's rule", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getAllByRole("button", { name: /Remove/ })[0] as HTMLElement);
    expect(screen.getAllByLabelText(i18next.t("setup.player_name"))).toHaveLength(1);
  });

  it("offers a difficulty only once a seat is a computer", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByLabelText(i18next.t("setup.bot_level_label"))).not.toBeInTheDocument();
    await user.click(within(seatCard(0)).getByRole("radio", { name: i18next.t("setup.bot") }));
    expect(screen.getByLabelText(i18next.t("setup.bot_level_label"))).toBeInTheDocument();
  });

  it("defaults the pronoun to the neutral value", () => {
    setup();
    const pronoun = screen.getAllByLabelText(i18next.t("setup.pronoun"))[0] as HTMLSelectElement;
    expect(pronoun.value).toBe("n");
  });
});

describe("Kids mode shows what it changes", () => {
  it("lists exactly the flags the endpoint marked, by their own label keys", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));

    expect(screen.getByText(i18next.t("setup.kids_changes"))).toBeInTheDocument();
    for (const label of [
      "ruleset.auctions_enabled",
      "ruleset.mortgages_enabled",
      "ruleset.hints_enabled",
      "ruleset.starting_cash",
    ]) {
      expect(screen.getByText(i18next.t(label))).toBeInTheDocument();
    }
    // And *not* the two flags the fixture ships unmarked. A screen rendering every flag it was
    // handed would pass the loop above and fail here — which is the whole of MON-417 on this side:
    // the client filters on the server's answer instead of computing its own.
    expect(
      screen.queryByText(i18next.t("ruleset.target_duration_minutes")),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(i18next.t("ruleset.double_salary_on_exact_go")),
    ).not.toBeInTheDocument();
  });

  it("reads the marks rather than a sentence — change which one is marked and the list follows", async () => {
    const user = userEvent.setup();
    // The falsifier. If the explanation were `setup.kids_explainer`, or any other literal, this
    // Kids rule set — whose only marked flag is a house rule — would still print "no auctions or
    // mortgages, simpler trades, hints on".
    setup({ rulesets: [UNIVERSAL_VIEW, KIDS_VIEW_ONE_CHANGE] });
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));

    expect(screen.getByText(i18next.t("ruleset.double_salary_on_exact_go"))).toBeInTheDocument();
    expect(screen.queryByText(i18next.t("ruleset.auctions_enabled"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18next.t("setup.kids_explainer", { minutes: 45 }))).toBeNull();
  });

  it("says so plainly when the endpoint marks nothing", async () => {
    const user = userEvent.setup();
    setup({ rulesets: [UNIVERSAL_VIEW, KIDS_VIEW_UNCHANGED] });
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));
    expect(screen.getByText(i18next.t("setup.kids_no_changes"))).toBeInTheDocument();
  });

  it("names each choice from the endpoint's own label key", () => {
    setup();
    // `t(ruleset.label_key)`, not `` t(`setup.${name}`) `` — the server names the choice.
    expect(screen.getByRole("radio", { name: i18next.t("setup.universal") })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: i18next.t("setup.kids") })).toBeInTheDocument();
  });

  it("shows both halves of a change, without a direction glyph that cannot mirror", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("radio", { name: i18next.t("setup.kids") }));
    const row = screen.getByText(i18next.t("ruleset.starting_cash")).parentElement;
    expect(row?.textContent).toContain("1000");
    // `universal_value` off the wire, not a baseline the client looked up and compared.
    expect(row?.textContent).toContain(i18next.t("ruleset.previous", { value: "1500" }));
    expect(row?.textContent).not.toContain("→");
  });

  it("shows nothing about changes while the full rules are chosen", () => {
    setup();
    expect(screen.queryByText(i18next.t("setup.kids_changes"))).not.toBeInTheDocument();
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
    await user.type(screen.getByLabelText(i18next.t("setup.player_name")), "Ruti");
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
    expect(screen.getByText(i18next.t("setup.cannot_start"))).toBeInTheDocument();
  });

  it.each([
    ["error.too_few_players", { minimum: 2, seats: 1 }],
    ["error.too_many_players", { maximum: 6, seats: 7 }],
    ["error.duplicate_names", { name: "Ruti" }],
  ])("shows the specific refusal %s rather than one coarse key", async (key, params) => {
    // MON-418. All three of these used to arrive as something the screen could not act on:
    // "at least two players" as `error.malformed_request` with a field path, because the constraint
    // was a pydantic `min_length`; duplicate names as `error.invalid_new_game`, which recites every
    // seating rule and leaves the parent to spot theirs.
    setup({ onStart: () => Promise.reject(new ApiError(422, key, params)) });
    await nameBothSeats(["Ruti", "Dan"]);
    await userEvent.setup().click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    await waitFor(() => {
      expect(screen.getByText(i18next.t(key, params))).toBeInTheDocument();
    });
  });

  it("falls back rather than throwing on a key the catalogue has not got yet", async () => {
    setup({ onStart: () => Promise.reject(new ApiError(422, "error.a_key_from_the_future")) });
    await nameBothSeats(["Ruti", "Dan"]);
    await userEvent.setup().click(screen.getByRole("button", { name: i18next.t("setup.start") }));

    // The catalogue throws on a missing key in dev and test by design (G-F17), so an unguarded
    // `t()` here would replace the form with a blank screen over one unmapped server key.
    await waitFor(() => {
      expect(screen.getByText(i18next.t("error.illegal_move"))).toBeInTheDocument();
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
    expect(document.activeElement?.textContent).toContain(i18next.t("setup.cannot_start"));
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
      within(secondSeat).getByLabelText(i18next.t("setup.bot_level_label")),
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

  // Deliberately *no* "uses no physical CSS property" test here. MON-412 owns that gate — the
  // `no-restricted-syntax` selectors plus `theme/logical-css.test.ts`, which scan the source
  // including template literals. Every className below is a plain literal, so a second
  // rendered-markup assertion would add no coverage; and a regex naming the physical utilities
  // is itself a string full of them, which trips the very lint it was written to reinforce.
});
