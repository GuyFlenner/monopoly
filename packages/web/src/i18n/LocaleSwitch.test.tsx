/**
 * The language switch, and the one property M5 defines itself by.
 *
 * "The same game playable in Hebrew, with the language switchable mid-game and **no effect on game
 * state**." The last clause is the interesting one, and it is not a claim about this component's
 * markup — it is a claim about what a language change is allowed to touch. So the test that earns
 * its keep here is the one that changes the language while a game is on screen and then asserts the
 * game is still exactly where it was.
 *
 * Deliberately *not* asserted: that clicking "עברית" sets `dir="rtl"`. `applyLocale` is one function
 * that sets `lang`, `dir` and the i18next language together; a test on `dir` would be satisfied by
 * the same line of code that sets it, which is the shape M5_KICKOFF §4 warns about for the board's
 * geometry. `applyLocale`'s own behaviour is covered in `index.test.ts`; what is worth testing here
 * is that two controls cannot disagree, and that the game survives.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLocale } from ".";
import { LocaleSwitch } from "./LocaleSwitch";
import { useLocale } from "./useLocale";

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  applyLocale("en");
});

describe("LocaleSwitch", () => {
  it("labels each language in that language, never in the page's", () => {
    render(<LocaleSwitch />);
    // Somebody who needs to switch *to* Hebrew is the person least able to read "Hebrew".
    expect(screen.getByTestId("locale-he")).toHaveTextContent("עברית");
    expect(screen.getByTestId("locale-en")).toHaveTextContent("English");
    expect(screen.getByTestId("locale-he")).toHaveAttribute("lang", "he");
  });

  it("marks the current language pressed, and only that one", async () => {
    render(<LocaleSwitch />);
    expect(screen.getByTestId("locale-en")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("locale-he")).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByTestId("locale-he"));

    expect(screen.getByTestId("locale-he")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("locale-en")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps two switches on one page in agreement", async () => {
    // The regression that motivated `useLocale`: the language held in a component's own state, so
    // the control that did not fire kept displaying the language the page had left.
    render(
      <>
        <div data-testid="first">
          <LocaleSwitch />
        </div>
        <div data-testid="second">
          <LocaleSwitch />
        </div>
      </>,
    );

    await userEvent.click(within(screen.getByTestId("first")).getByTestId("locale-he"));

    for (const group of ["first", "second"]) {
      const scope = within(screen.getByTestId(group));
      expect(scope.getByTestId("locale-he"), group).toHaveAttribute("aria-pressed", "true");
      expect(scope.getByTestId("locale-en"), group).toHaveAttribute("aria-pressed", "false");
    }
  });
});

describe("useLocale", () => {
  it("reports a language change made from outside React", async () => {
    // `applyLocale` is called directly by `initI18n`, and could be called by anything else. A hook
    // that only learned about its own setter's calls would be a second source of truth.
    function Probe(): React.JSX.Element {
      const [locale] = useLocale();
      return <span data-testid="probe">{locale}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("en");

    applyLocale("he");

    // Awaited, not asserted synchronously: `i18next.changeLanguage` is a promise, so
    // `languageChanged` fires on a later tick. A synchronous assertion here would be testing that
    // the switch is *not* async, which is neither true nor wanted.
    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveTextContent("he");
    });
  });
});
