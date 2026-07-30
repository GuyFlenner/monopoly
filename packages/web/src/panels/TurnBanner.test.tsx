import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePlayer } from "@/test/fixtures";
import { TOKEN_SHAPE_PATH, TOKEN_IDENTITY } from "@/theme";

import { KIDS_TOKEN_PX, TurnBanner } from "./TurnBanner";

/**
 * The pre-reader's channel, and the two ways it goes quietly wrong.
 *
 * The banner is only worth having if the piece on it is the *same* piece the board is moving. So the
 * assertion below is against `TOKEN_IDENTITY`'s own shape path rather than against "an svg is
 * present": drawing seat 2's capsule for the seat holding the dice is a bug a screenshot review
 * passes, because the banner still looks correct on its own.
 *
 * It must also not become a live region. `useEventNarration` already announces the turn change
 * assertively through the root `<Announcer>`; a second voice here would say it twice (GAP D1/G-54).
 */

const PLAYERS = [makePlayer(0, { name: "Ruti" }), makePlayer(1, { name: "Dan" })];

/** An identity `t`, so an assertion is about the key reached rather than about English wording. */
const keys = (key: string, params?: Readonly<Record<string, string | number>>): string =>
  `${key}(${JSON.stringify(params ?? {})})`;

describe("TurnBanner", () => {
  it("names the acting seat through the catalogue", () => {
    render(
      <TurnBanner players={PLAYERS} currentId={1} turnNumber={7} kids={false} t={keys} />, //
    );
    expect(screen.getByTestId("turn-banner-name")).toHaveTextContent('turn.banner({"name":"Dan"})');
  });

  it("draws the piece belonging to the acting seat, not the first one", () => {
    const { container } = render(
      <TurnBanner players={PLAYERS} currentId={1} turnNumber={7} kids={false} t={keys} />,
    );
    // Seat 2 for the second entry in `state.players` order — the same mapping the board uses.
    const second = TOKEN_IDENTITY[1];
    const paths = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
    expect(paths).toContain(TOKEN_SHAPE_PATH[second.shape]);
    expect(paths).not.toContain(TOKEN_SHAPE_PATH[TOKEN_IDENTITY[0].shape]);
  });

  it("reads the turn number rather than counting anything", () => {
    render(<TurnBanner players={PLAYERS} currentId={0} turnNumber={31} kids={false} t={keys} />);
    expect(screen.getByTestId("turn-banner").textContent).toContain('label.turn({"number":31})');
  });

  it("still answers whose turn it is when the seat has no identity", () => {
    // An id outside `players` is a projection this component cannot draw a piece for. Rendering
    // nothing at all would take away the one thing the banner exists to say.
    render(<TurnBanner players={PLAYERS} currentId={9} turnNumber={1} kids={false} t={keys} />);
    expect(screen.getByTestId("turn-banner-name")).toHaveTextContent('{"name":"9"}');
  });

  it("draws the piece larger in a kids game", () => {
    const { container } = render(
      <TurnBanner players={PLAYERS} currentId={0} turnNumber={1} kids t={keys} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", String(KIDS_TOKEN_PX));
    expect(screen.getByTestId("turn-banner").dataset.kids).toBe("true");
  });

  it("is not a live region", () => {
    const { container } = render(
      <TurnBanner players={PLAYERS} currentId={0} turnNumber={1} kids={false} t={keys} />,
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
  });
});
