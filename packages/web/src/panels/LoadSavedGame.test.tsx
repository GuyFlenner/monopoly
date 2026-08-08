/**
 * The load affordance and its three states (MON-704, MON-708).
 *
 * The interesting requirements are the accessibility ones, because the obvious implementation fails
 * them: a `<button>` forwarding its click to a hidden `<input type="file">` looks right and cannot be
 * operated by keyboard, since the *input* is what has to be focused for Space to open the dialog. So
 * there is a test that tabs to the control and one that checks the label is tied to it.
 *
 * The failure cases are the other half. A save that the server refuses — a stale `schema_version`,
 * a game id already live, a file too big — has to say which, in the player's language, from the
 * server's own key. That is the "no untranslated errors" criterion, and it is asserted per key.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";

import { ApiError, NO_RESPONSE } from "@/api";
import { expectAxeClean } from "@/test/axe";

import { LoadSavedGame, type LoadSavedGameProps } from "./LoadSavedGame";

/** A save file as the browser hands one over. Contents only have to be JSON. */
function savedGame(body: unknown = { schema_version: 1, game_id: "g1" }): File {
  return new File([JSON.stringify(body)], "kesef-street-g1-turn-4.json", {
    type: "application/json",
  });
}

function control(): HTMLInputElement {
  // The input is the control, so this is what a test picks up — `getByLabelText` rather than
  // `getByRole("button")`, which is the assertion that the label is actually tied to it.
  return screen.getByLabelText<HTMLInputElement>("Choose a saved game file");
}

describe("LoadSavedGame", () => {
  it("posts the parsed contents of the chosen file", async () => {
    const onLoad = vi.fn(() => Promise.resolve());
    render(<LoadSavedGame onLoad={onLoad} />);

    await userEvent.upload(control(), savedGame({ schema_version: 1, game_id: "kitchen" }));

    // The *parsed* document, not the `File` — and unvalidated, because whether it is a `GameState` is
    // the engine's question, answered on the far side of `POST /games/load`.
    // `undefined` for `ifExists`: a first attempt carries no conflict policy, so the server's own
    // default refuses and asks rather than this component deciding on the player's behalf (ADR-011).
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledWith({ schema_version: 1, game_id: "kitchen" }, undefined);
    });
  });

  it("is reachable from the keyboard", async () => {
    // The requirement the styled-`<div>` implementation fails. A real focusable input, visually
    // hidden inside a `<label>` that carries the 44 px floor — the same technique `SetupScreen`'s
    // radio cards use.
    render(<LoadSavedGame onLoad={() => Promise.resolve()} />);
    await userEvent.tab();
    expect(control()).toHaveFocus();
  });

  it("puts the 44 px floor on the label, which is the thing that gets pressed", () => {
    render(<LoadSavedGame onLoad={() => Promise.resolve()} />);
    // The input is `sr-only`; the target is its label. jsdom lays nothing out, so what is checkable
    // is that the label opted into the `target` utility rather than sizing its own smaller box.
    const label = control().closest("label");
    expect(label?.className).toContain("target");
    expect(label?.className).toContain("min-h-11");
  });

  it("shows a loading state while the save is in flight, and clears it after", async () => {
    let release: (() => void) | undefined;
    const onLoad = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<LoadSavedGame onLoad={onLoad} />);

    await userEvent.upload(control(), savedGame());
    expect(await screen.findByText("Opening the saved game…")).toBeInTheDocument();

    release?.();
    await waitFor(() => {
      expect(screen.queryByText("Opening the saved game…")).toBeNull();
    });
  });

  it("renders the server's own key for a stale save, in the catalogue's words", async () => {
    // MON-704's headline failure: `error.save_schema_mismatch` is the keyed 422 the load route
    // answers for a `schema_version` the engine no longer reads.
    render(
      <LoadSavedGame
        onLoad={() => Promise.reject(new ApiError(422, "error.save_schema_mismatch"))}
      />,
    );

    await userEvent.upload(control(), savedGame());

    expect(await screen.findByText("Couldn't open that saved game")).toBeInTheDocument();
    expect(
      screen.getByText("This saved game was made by a different version of Kesef Street."),
    ).toBeInTheDocument();
  });

  it("renders every other refusal the load route can answer", async () => {
    // One per status the route declares, so a keyed body this screen cannot render is a failing test
    // rather than an `error.network` in front of a parent.
    const cases = [
      [409, "error.game_already_exists", "There's already a game with that name."],
      [413, "error.save_too_large", "That saved game is too big to load."],
      [422, "error.invalid_game_id", "That isn't a valid game name."],
      [503, "error.server_at_capacity", "The table is full — 4 games are already running."],
    ] as const;

    for (const [status, key, sentence] of cases) {
      const { unmount } = render(
        <LoadSavedGame onLoad={() => Promise.reject(new ApiError(status, key, { limit: 4 }))} />,
      );
      await userEvent.upload(control(), savedGame());
      expect(await screen.findByText(sentence), key).toBeInTheDocument();
      unmount();
    }
  });

  /*
    The conflict question (MON-714, ADR-011).

    Every test below drives the *whole* exchange — upload, refusal, press, re-post — because the
    thing worth asserting is what the second request carries. A test that only checked the buttons
    appeared would pass against two buttons wired to nothing.
  */
  describe("when the game in the save is still being played", () => {
    /**
     * An `onLoad` that refuses a first attempt with the conflict and accepts any answer to it.
     *
     * Typed as a mock *of the prop's own signature* (MON-750): under vitest 2 this said
     * `ReturnType<typeof vi.fn>`, which asserted nothing about what the mock is called with, and
     * vitest 4's `vi.fn` — whose bare return type is now `Mock<Procedure | Constructable>`, since a
     * mock may stand in for a constructor — stopped being assignable to the prop at all.
     */
    function refusingFirst(): Mock<LoadSavedGameProps["onLoad"]> {
      return vi.fn((_save: unknown, ifExists?: string) =>
        ifExists === undefined
          ? Promise.reject(new ApiError(409, "error.game_already_exists", { game_id: "g1" }))
          : Promise.resolve(),
      );
    }

    it("offers the two answers, under the refusal that asked the question", async () => {
      render(<LoadSavedGame onLoad={refusingFirst()} />);
      await userEvent.upload(control(), savedGame());

      // The sentence the player is answering is still on screen: the buttons are an answer to it,
      // not a replacement for it.
      expect(await screen.findByText("There's already a game with that name.")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Replace the game in progress" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Load as a separate game" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("re-posts the same file with replace when that is what the player chose", async () => {
      const onLoad = refusingFirst();
      render(<LoadSavedGame onLoad={onLoad} />);
      await userEvent.upload(control(), savedGame({ schema_version: 1, game_id: "kitchen" }));

      await userEvent.click(
        await screen.findByRole("button", { name: "Replace the game in progress" }),
      );

      // The *same document*, and the answer beside it. A retry that re-read the input would have
      // nothing to read: `value` is cleared after every attempt (see the component).
      await waitFor(() => {
        expect(onLoad).toHaveBeenLastCalledWith(
          { schema_version: 1, game_id: "kitchen" },
          "replace",
        );
      });
      expect(onLoad).toHaveBeenCalledTimes(2);
    });

    it("re-posts with copy when the player would rather keep both", async () => {
      const onLoad = refusingFirst();
      render(<LoadSavedGame onLoad={onLoad} />);
      await userEvent.upload(control(), savedGame({ schema_version: 1, game_id: "kitchen" }));

      await userEvent.click(await screen.findByRole("button", { name: "Load as a separate game" }));

      await waitFor(() => {
        expect(onLoad).toHaveBeenLastCalledWith({ schema_version: 1, game_id: "kitchen" }, "copy");
      });
    });

    it("clears the question and the refusal on cancel, leaving the picker", async () => {
      const onLoad = refusingFirst();
      render(<LoadSavedGame onLoad={onLoad} />);
      await userEvent.upload(control(), savedGame());

      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      // Both go: a red message beside an unanswered question says the load is still failing when the
      // player has decided not to make one.
      expect(screen.queryByTestId("load-save-conflict")).toBeNull();
      expect(screen.queryByText("There's already a game with that name.")).toBeNull();
      expect(control()).toBeInTheDocument();
      expect(onLoad).toHaveBeenCalledTimes(1);
    });

    it("does not drop the keyboard when the question is cancelled", async () => {
      // The buttons unmount themselves, so without somewhere to put focus the browser drops it to
      // `<body>`: a player who cancelled by keyboard is silently returned to the top of the tab order
      // with nothing announced. MON-703's `disabled` finding in a different shape.
      render(<LoadSavedGame onLoad={refusingFirst()} />);
      await userEvent.upload(control(), savedGame());

      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      expect(control(), "focus was dropped to the body").toHaveFocus();
    });

    it("does not ask twice when the answer is refused with the same key", async () => {
      // The loop this prevents: a `replace` that came back 409 is a genuine failure, not the question
      // again. Without the `ifExists === undefined` guard the prompt would reappear forever.
      const onLoad = vi.fn(() =>
        Promise.reject(new ApiError(409, "error.game_already_exists", { game_id: "g1" })),
      );
      render(<LoadSavedGame onLoad={onLoad} />);
      await userEvent.upload(control(), savedGame());

      await userEvent.click(
        await screen.findByRole("button", { name: "Replace the game in progress" }),
      );

      await waitFor(() => {
        expect(onLoad).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByTestId("load-save-conflict")).toBeNull();
      expect(screen.getByText("There's already a game with that name.")).toBeInTheDocument();
    });

    it("asks nothing for a refusal that has no answer", async () => {
      // A stale save is not a conflict, and offering to "replace the game in progress" would be
      // offering something that cannot work.
      render(
        <LoadSavedGame
          onLoad={() => Promise.reject(new ApiError(422, "error.save_schema_mismatch"))}
        />,
      );
      await userEvent.upload(control(), savedGame());

      await screen.findByText("This saved game was made by a different version of Kesef Street.");
      expect(screen.queryByTestId("load-save-conflict")).toBeNull();
    });

    it("is axe clean with the question on screen", async () => {
      const { container } = render(<LoadSavedGame onLoad={refusingFirst()} />);
      await userEvent.upload(control(), savedGame());
      await screen.findByTestId("load-save-conflict");
      await expectAxeClean(container);
    });
  });

  it("names a file that is not JSON at all, without asking the server", async () => {
    // `error.save_unreadable`, thrown client-side. A photograph renamed to `.json` is not a save
    // from a different version of the game, and saying it is sends a parent looking for an upgrade.
    const onLoad = vi.fn(() => Promise.resolve());
    render(<LoadSavedGame onLoad={onLoad} />);

    await userEvent.upload(
      control(),
      new File(["PNG\r\n\n"], "photo.json", { type: "application/json" }),
    );

    expect(
      await screen.findByText("That file isn't a Kesef Street saved game."),
    ).toBeInTheDocument();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("lets the same file be chosen again after a failure", async () => {
    // Without the `value = ""` reset, choosing the same file twice fires no `change` event — so a
    // player whose first attempt failed transiently finds that the control silently does nothing.
    const onLoad = vi
      .fn<(save: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(NO_RESPONSE, "error.network"))
      .mockResolvedValueOnce(undefined);
    render(<LoadSavedGame onLoad={onLoad} />);

    const file = savedGame();
    await userEvent.upload(control(), file);
    expect(await screen.findByText("Network error. Please try again.")).toBeInTheDocument();
    expect(control().value).toBe("");

    await userEvent.upload(control(), file);
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledTimes(2);
    });
  });

  it("treats a cancelled dialog as no attempt at all", async () => {
    const onLoad = vi.fn(() => Promise.resolve());
    render(<LoadSavedGame onLoad={onLoad} />);

    // What the browser fires when the player opens the picker and presses Escape.
    await userEvent.upload(control(), []);

    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.queryByText("Couldn't open that saved game")).toBeNull();
  });

  it("is axe clean, idle and failed", async () => {
    const { container, unmount } = render(<LoadSavedGame onLoad={() => Promise.resolve()} />);
    await expectAxeClean(container);
    unmount();

    const failing = render(
      <LoadSavedGame
        onLoad={() => Promise.reject(new ApiError(422, "error.save_schema_mismatch"))}
      />,
    );
    await userEvent.upload(control(), savedGame());
    await screen.findByText("Couldn't open that saved game");
    await expectAxeClean(failing.container);
  });
});
