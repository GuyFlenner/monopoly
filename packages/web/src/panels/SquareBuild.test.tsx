/**
 * What must be true of the "can a house go here?" panel.
 *
 * The tests that earn their keep are the ones that would go red if this component started *deciding*
 * rather than asking: the sentence has to be the engine's, the command has to be the square's owner's,
 * and a slow answer for a square the player has already left must never be shown. Everything else —
 * that a check glyph appears — is one assertion, because the catalogue is not the risk.
 */

import { render, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { describe, expect, it, vi } from "vitest";

import type { Command, LegalityView } from "@/api";
import type { GroupNameScope } from "@/i18n/groupNames";

import { SquareBuild } from "./SquareBuild";

const SCOPE: GroupNameScope = {
  boardId: "classic",
  translate: (key, params) => i18next.t(key, params ?? {}),
  exists: (key) => i18next.exists(key),
};

function legal(): LegalityView {
  return { legal: true, reason_key: null, params: {} };
}

function refused(reason_key: string, params: Record<string, unknown> = {}): LegalityView {
  return { legal: false, reason_key, params } as unknown as LegalityView;
}

/** A `validate` that answers `view`, and records what it was asked. */
function asking(view: LegalityView) {
  const seen: Command[] = [];
  const validate = vi.fn((command: Command) => {
    seen.push(command);
    return Promise.resolve(view);
  });
  return { validate, seen };
}

function renderPanel(view: LegalityView, tile = 6, owner = 2) {
  const { validate, seen } = asking(view);
  render(<SquareBuild tile={tile} owner={owner} validate={validate} scope={SCOPE} />);
  return { validate, seen };
}

describe("asking rather than deciding", () => {
  it("asks about a build on the selected square, for the square's owner", async () => {
    const { seen } = renderPanel(legal(), 6, 2);
    await screen.findByTestId("square-build");
    // The owner, not whoever is looking: portfolio actions are open to every solvent seat (MON-204),
    // so the owner is the seat the answer is meaningful for even on somebody else's turn.
    expect(seen).toEqual([{ kind: "build_house", player: 2, tile: 6 }]);
  });

  it("says a house can go here when the engine says it can", async () => {
    renderPanel(legal());
    const panel = await screen.findByTestId("square-build");
    expect(panel.dataset.legal).toBe("true");
    expect(panel).toHaveTextContent("A house can go here.");
  });

  it("gives the engine's own reason, figures and all, rather than a paraphrase", async () => {
    // The sentence MON-723 wrote and nothing could previously trigger for a build. This is the
    // owner's report: a complete group, not enough cash, and no explanation anywhere on screen.
    renderPanel(refused("error.insufficient_funds", { required: 100, available: 60 }));
    const panel = await screen.findByTestId("square-build");
    expect(panel.dataset.legal).toBe("false");
    expect(panel).toHaveTextContent(/costs .*100.* and you have .*60/);
  });

  it("names the colour group through the board's own scope", async () => {
    // `group_key` is MON-415's convention: the engine ships a key, not "dark_blue", so the Israeli
    // board renames the set for free. A second resolver here is how one screen explains a group twice.
    renderPanel(refused("error.group_incomplete", { group_key: "group.dark_blue" }));
    const panel = await screen.findByTestId("square-build");
    expect(panel).toHaveTextContent(/whole .+ set/);
    expect(panel).not.toHaveTextContent("group.dark_blue");
  });

  it("falls back rather than blanking the panel on a key it has never heard of", async () => {
    // `missingKeyHandler` throws under test by design, so an unguarded `t()` on a key a newer engine
    // invented would replace the board's square panel with a blank screen.
    renderPanel(refused("error.some_rule_invented_next_year"));
    const panel = await screen.findByTestId("square-build");
    expect(panel).toHaveTextContent("A house cannot go here.");
  });

  it("waits quietly, and does not narrate a wait that repeats per square", () => {
    const validate = vi.fn(() => new Promise<LegalityView>(() => undefined));
    render(<SquareBuild tile={6} owner={0} validate={validate} scope={SCOPE} />);
    expect(screen.getByTestId("square-build-checking")).toBeInTheDocument();
    // A player crossing the board opens several squares; one polite announcement each is a screen
    // reader nobody can use. Same argument as the trade seal's.
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("keeps the panel quiet when the question itself fails", async () => {
    // A failed *question* is not a red banner over the board: the player still has the square's name,
    // its rent and its owner, and the next selection asks again.
    const validate = vi.fn(() => Promise.reject(new Error("offline")));
    render(<SquareBuild tile={6} owner={0} validate={validate} scope={SCOPE} />);
    await waitFor(() => {
      expect(validate).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("square-build")).not.toBeInTheDocument();
    expect(screen.getByTestId("square-build-checking")).toBeInTheDocument();
  });
});

describe("a slow answer cannot describe the wrong square", () => {
  it("shows the current square's verdict when an earlier one resolves late", async () => {
    // Select 6, then 8 before 6 answers. The late answer for 6 must not be stamped on 8 — which is
    // the failure a plain `setState` in a promise gives you, and it would read as the engine being
    // wrong about a square rather than as a race.
    let releaseFirst: (view: LegalityView) => void = () => undefined;
    const validate = vi.fn((command: Command) => {
      if ("tile" in command && command.tile === 6) {
        return new Promise<LegalityView>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(refused("error.no_houses_left"));
    });

    const { rerender } = render(
      <SquareBuild tile={6} owner={0} validate={validate} scope={SCOPE} />,
    );
    rerender(<SquareBuild tile={8} owner={0} validate={validate} scope={SCOPE} />);

    const panel = await screen.findByTestId("square-build");
    expect(panel).toHaveTextContent("The bank has run out of houses.");

    // Square 6's answer arrives now, for a square nobody is looking at.
    releaseFirst(legal());
    await waitFor(() => {
      expect(screen.getByTestId("square-build")).toHaveTextContent(
        "The bank has run out of houses.",
      );
    });
  });

  it("does not leave the previous square's answer on screen while the new one is in flight", async () => {
    /*
      The case the `verdict.tile === tile` guard exists for, and the one the cleanup flag alone does
      *not* cover. Square 6 answers quickly; the player then opens square 8. Until 8 answers, the
      state still holds 6's verdict — so without the guard the panel reads "a house can go here"
      about a square nothing has been asked about yet, which is worse than saying nothing.
    */
    const validate = vi.fn((command: Command) => {
      if ("tile" in command && command.tile === 6) {
        return Promise.resolve(legal());
      }
      return new Promise<LegalityView>(() => undefined);
    });

    const { rerender } = render(
      <SquareBuild tile={6} owner={0} validate={validate} scope={SCOPE} />,
    );
    expect(await screen.findByTestId("square-build")).toHaveTextContent("A house can go here.");

    rerender(<SquareBuild tile={8} owner={0} validate={validate} scope={SCOPE} />);
    expect(screen.queryByTestId("square-build")).not.toBeInTheDocument();
    expect(screen.getByTestId("square-build-checking")).toBeInTheDocument();
  });

  it("drops an answer about the seat that used to own this square", async () => {
    /*
      The case the cleanup flag exists for, and the one the tile guard cannot catch: the square is
      traded while it is open. The tile never changes, so a late answer about the *previous* owner
      passes a tile comparison — and "a house can go here" would then be a statement about somebody
      who no longer owns the deed.
    */
    let releaseFirst: (view: LegalityView) => void = () => undefined;
    let asked = 0;
    const validate = vi.fn(() => {
      asked += 1;
      if (asked === 1) {
        return new Promise<LegalityView>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return new Promise<LegalityView>(() => undefined);
    });

    const { rerender } = render(
      <SquareBuild tile={6} owner={2} validate={validate} scope={SCOPE} />,
    );
    // Traded: same square, new owner. The question is asked again for the new seat.
    rerender(<SquareBuild tile={6} owner={5} validate={validate} scope={SCOPE} />);
    expect(validate).toHaveBeenCalledTimes(2);

    releaseFirst(legal());
    await waitFor(() => {
      expect(validate).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId("square-build")).not.toBeInTheDocument();
    expect(screen.getByTestId("square-build-checking")).toBeInTheDocument();
  });

  it("asks again when the square changes", async () => {
    const { validate } = renderPanel(legal(), 6, 0);
    await screen.findByTestId("square-build");
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
