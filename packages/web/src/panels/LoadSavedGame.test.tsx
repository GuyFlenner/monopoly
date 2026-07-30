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
import { describe, expect, it, vi } from "vitest";

import { ApiError, NO_RESPONSE } from "@/api";
import { expectAxeClean } from "@/test/axe";

import { LoadSavedGame } from "./LoadSavedGame";

/** A save file as the browser hands one over. Contents only have to be JSON. */
function savedGame(body: unknown = { schema_version: 1, game_id: "g1" }): File {
  return new File([JSON.stringify(body)], "kesef-street-g1-turn-4.json", {
    type: "application/json",
  });
}

function control(): HTMLInputElement {
  // The input is the control, so this is what a test picks up — `getByLabelText` rather than
  // `getByRole("button")`, which is the assertion that the label is actually tied to it.
  return screen.getByLabelText("Choose a saved game file") as HTMLInputElement;
}

describe("LoadSavedGame", () => {
  it("posts the parsed contents of the chosen file", async () => {
    const onLoad = vi.fn(() => Promise.resolve());
    render(<LoadSavedGame onLoad={onLoad} />);

    await userEvent.upload(control(), savedGame({ schema_version: 1, game_id: "kitchen" }));

    // The *parsed* document, not the `File` — and unvalidated, because whether it is a `GameState` is
    // the engine's question, answered on the far side of `POST /games/load`.
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledWith({ schema_version: 1, game_id: "kitchen" });
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
        <LoadSavedGame
          onLoad={() => Promise.reject(new ApiError(status, key, { limit: 4 }))}
        />,
      );
      await userEvent.upload(control(), savedGame());
      expect(await screen.findByText(sentence), key).toBeInTheDocument();
      unmount();
    }
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
