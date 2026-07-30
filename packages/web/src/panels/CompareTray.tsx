/**
 * One to three dossiers side by side, and the button that puts them there (MON-702).
 *
 * ## It reuses the dossier rather than reproducing it
 *
 * The tray renders `<PlayerDossier compact>` — the same component, the same figures, the same deed
 * list, the same `group_holdings` in the same server order. There is no `CompactPlayerDossier` and
 * no second layout, because the second one drifts and the figure that drifts is net worth: the whole
 * point of comparing two seats is that the two numbers were produced the same way. `compact` is a
 * presentation prop on the one component (padding, two columns of figures instead of four), which is
 * what MON-702 asks for by name.
 *
 * Kids Mode needs nothing here. The mortgage wording inside a dossier is not gated at all — the
 * readouts render from `properties[i].mortgaged`, so with mortgages switched off they are simply
 * never true, and a gate would be this file holding a second opinion about data (`game/presentation.ts`
 * spells out that line). The comfort scale reaches the tray for free: it is one `data-comfort`
 * attribute on the game screen's outermost box, so every `.target` below — including the pin toggles
 * and the tray's scroll region — grows together.
 *
 * ## The scroll is the tray's, never the page's
 *
 * `overflow-x: auto` sits on the rail that holds the cards. That is the requirement and it is also
 * the only correct place for it: three 18 rem cards do not fit at 320 px, and a page that scrolls
 * horizontally instead loses the action bar off the side of the screen.
 *
 * Everything about the geometry is logical — `gap`, `min-inline-size`, `flex`, `scroll-p*` — so the
 * rail fills from the right in Hebrew and from the left in English with no branch. There is no
 * `scrollLeft` anywhere: its sign is inverted under `dir="rtl"` differently by different engines,
 * which is why the ESLint rule refuses it outright, and the ordering claim is asserted
 * *geometrically* in `e2e/compare.spec.ts` rather than by reading an attribute back.
 *
 * The rail is a focusable `role="group"` because a region that scrolls must be reachable by
 * keyboard — axe's `scrollable-region-focusable`, the same rule `EventLog` cites. Unpinning is a
 * real button on each card, so nothing in here is drag-only or hover-only (§5.5).
 *
 * ## Nothing speaks except the pin toggle
 *
 * `<PlayerDossier>` renders no live region, and neither does the tray. The pin toggle announces
 * through the root `<Announcer>` (MON-411) because it knows the one thing nobody else does: that a
 * person just pressed it. There is no second `aria-live` region anywhere in this file (GAP G-D1/G-54).
 */

import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useAnnounce } from "@/a11y";
import type { BoardView, PlayerView } from "@/api";
import type { PropertyProjection } from "@/board";
import { MAX_PINNED_PLAYERS, useUiStore } from "@/game";

import { PlayerDossier } from "./PlayerDossier";

export interface PinToggleProps {
  readonly playerId: number;
  /** The seat's own name, for the announcement. A lookup in `state.players`, never derived. */
  readonly name: string;
  readonly className?: string | undefined;
}

/**
 * Pin this seat into the tray, or take it out again.
 *
 * Lives here rather than inside `<PlayerDossier>` so that the card stays silent and knows nothing
 * about comparing: the dossier takes it as an `actions` slot. That means the same button works from
 * the aside's dossier — the "reachable for any player at any time" surface (spec §5.2, MON-406) —
 * and from a card already in the tray, with one implementation and one announcement.
 *
 * At the ceiling it is `aria-disabled` rather than `disabled`, and pressing it says why. A disabled
 * control cannot be focused, so a keyboard user tabbing the seat list would find a button that
 * silently does nothing and no explanation anywhere; this way the reason is announced by the thing
 * that was pressed.
 */
export function PinToggle({ playerId, name, className }: PinToggleProps): React.JSX.Element {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const pinned = useUiStore((ui) => ui.pinnedPlayers);
  const togglePin = useUiStore((ui) => ui.togglePin);

  const isPinned = pinned.includes(playerId);
  const atCeiling = !isPinned && pinned.length >= MAX_PINNED_PLAYERS;

  return (
    <button
      type="button"
      aria-pressed={isPinned}
      aria-disabled={atCeiling}
      data-testid={`pin-player-${String(playerId)}`}
      onClick={() => {
        if (atCeiling) {
          announce({
            politeness: "polite",
            key: "dossier.pin_limit",
            params: { max: MAX_PINNED_PLAYERS },
          });
          return;
        }
        togglePin(playerId);
        announce({
          politeness: "polite",
          key: isPinned ? "a11y.unpinned" : "a11y.pinned",
          params: { name },
        });
      }}
      className={[
        "target bg-tile text-ink border-hairline rounded-xl border px-3 py-2 text-xs font-semibold",
        "aria-pressed:font-bold",
        atCeiling ? "opacity-55" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {t(isPinned ? "dossier.unpin" : "dossier.pin")}
      {atCeiling && (
        <span className="sr-only"> {t("dossier.pin_limit", { max: MAX_PINNED_PLAYERS })}</span>
      )}
    </button>
  );
}

export interface CompareTrayProps {
  /** Every seat in `state.players` order — the dossier needs it for seat identity. */
  readonly players: readonly PlayerView[];
  readonly board: BoardView | undefined;
  readonly properties: readonly PropertyProjection[];
  readonly currentPlayerId: number;
  readonly onSelectSquare?: ((tile: number) => void) | undefined;
  /** The animation queue's cash beat per seat (MON-701). Presentation only. */
  readonly cashPulse?: ((playerId: number) => number | undefined) | undefined;
}

export function CompareTray({
  players,
  board,
  properties,
  currentPlayerId,
  onSelectSquare,
  cashPulse,
}: CompareTrayProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const headingId = useId();
  const pinned = useUiStore((ui) => ui.pinnedPlayers);

  /*
    Pin order, filtered through the seats that exist.

    The filter is not defensive noise: a save file loaded into a game with fewer seats, or a pin held
    across "New game", would otherwise leave an id in the store with no player behind it. Dropping it
    shows two cards instead of two cards and a crash.
  */
  const cards = pinned
    .map((playerId) => players.find((player) => player.id === playerId))
    .filter((player): player is PlayerView => player !== undefined);

  /*
    Nothing pinned, nothing drawn — deliberately, rather than an empty state.

    `<EmptyState>` is for a surface a player navigated *to* and found empty; the tray is a surface
    that appears because a player pinned something. A permanent empty rail under the board would be
    chrome explaining a feature nobody had asked for yet, and the affordance that starts it is
    already on every dossier.
  */
  if (cards.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="compare-tray"
      data-pinned={cards.length}
      className="flex min-w-0 flex-col gap-2"
    >
      <h2
        id={headingId}
        className="text-on-table text-xs font-semibold tracking-[0.16em] uppercase opacity-80"
      >
        {t("dossier.compare")}
      </h2>

      {/*
        The rail. `overflow-x-auto` is the tray's own, never the page's, and every other length here
        is logical — so this fills from the inline start in both languages with no branch and no
        `scrollLeft` (which the lint refuses, because its sign flips under `dir="rtl"`).

        `tabIndex={0}` because a scrollable box has to be reachable by keyboard or its content is
        unreachable without a mouse — axe reports exactly that as `scrollable-region-focusable`, and
        the E4 gate is "axe clean". It carries no role of its own: the `<section>` above is already
        the named region, and a second one with the same name is two landmarks for one tray. The
        suppression below is `EventLog`'s, for the identical reason and with the identical shape.
      */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div
        tabIndex={0}
        data-testid="compare-tray-rail"
        className="flex items-start gap-3 overflow-x-auto overflow-y-visible pb-2"
      >
        {cards.map((player) => (
          <div key={player.id} className="flex w-72 min-w-72 shrink-0 flex-col">
            <PlayerDossier
              compact
              player={player}
              players={players}
              board={board}
              properties={properties}
              isCurrent={player.id === currentPlayerId}
              onSelectSquare={onSelectSquare}
              cashPulse={cashPulse?.(player.id)}
              actions={<PinToggle playerId={player.id} name={player.name} />}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
