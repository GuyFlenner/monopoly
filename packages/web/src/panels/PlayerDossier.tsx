/**
 * One player's deeds, laid out like a wallet of title cards seen edge-on.
 *
 * ## Not one number on this card is computed
 *
 * This is the item where the temptation is strongest and the failure is quietest, so it is worth
 * being explicit about every figure on the card and where it comes from:
 *
 * | Shown | Read from | Never |
 * |---|---|---|
 * | cash | `PlayerView.cash` | — |
 * | net worth | `PlayerView.net_worth` | a sum of prices; a mortgaged deed counts zero, which is a *rule* (MON-208) |
 * | `2 of 3` | `GroupHoldings.owned` / `.total` | a count of the squares this component grouped |
 * | "Complete set" | `GroupHoldings.complete` | `owned === total` — `complete` is `state.owns_whole_group(...)`, the engine's answer to "may this player build" |
 * | houses in a set | `GroupHoldings.houses` | a sum over `state.properties` |
 * | mortgaged in a set | `GroupHoldings.mortgaged_count` | a count of `mortgaged` flags |
 * | squares held | `PlayerView.tiles_owned.length` | — |
 * | jail cards | `PlayerView.jail_cards.length` | — |
 *
 * Every one of those fields exists on the wire *because* the dossier would otherwise re-derive it
 * (GAP G-31, the fix that shipped them). `owned === total` is the specific expression this file is
 * most likely to have contained, and `PlayerDossier.test.tsx` feeds it a `group_holdings` whose
 * `complete` disagrees with that comparison in both directions and asserts the projected value wins.
 *
 * What this file *does* do with the board is a lookup: an owned tile index becomes a `TileView` and
 * a `TileThemeKey`, so the squares can be filed under the right band. The completion figure is never
 * taken from those buckets — the buckets decide where a name is printed, the projection decides what
 * the card claims.
 *
 * ## Public, always, for anybody
 *
 * There is no per-seat gating and no "is it your turn" branch. Under the universal rules holdings
 * are public information, so any player's dossier is readable at any time including on someone
 * else's turn (spec §5.2). `isCurrent` exists only to draw the acting seat a little more brightly.
 *
 * ## Two identity channels everywhere, never colour alone
 *
 * The seat is shape + colour + icon from `TOKEN_IDENTITY`, the same piece the board draws
 * (GAP G-51). A colour set is band + pattern + icon + name from `TILE_THEME`, with the keyline
 * MON-412 added — the band's fill alone measures about 1.4:1 against a card face and it is the
 * hairline rim that reaches the non-text floor, so the spine is always rimmed (`surfaces.ts`).
 * Completion has a third channel on top of the words: one pip per square in the set, inked for the
 * ones held, which a child can count before they can read "2 of 3".
 *
 * ## Nothing here speaks
 *
 * No `aria-live`. The one live region belongs to `<Announcer>` (GAP D1/G-54); a dossier that
 * announced itself would narrate a player's whole portfolio every time a house was built.
 *
 * *Visual direction*: the deed spine is the flourish and the only one — a colour band stood on its
 * end down the inline-start edge of each row, so ten sets read as a wallet rather than a table.
 * Everything else is a quiet ledger: hairline rules, tabular figures, one accent.
 *
 * The band patterns are `<defs>` in the single `<ThemeSprite/>` at the app root (see
 * `patterns.tsx`); `url(#…)` resolves document-wide, so this component references them rather than
 * mounting a second copy and duplicating every id in the document.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView, GroupHoldings, PlayerView, TileView } from "@/api";
import {
  HOTEL_LEVEL,
  seatOf,
  tileThemeKey,
  Token,
  TOKEN_PX,
  type PropertyProjection,
} from "@/board";
import { bandFill, GROUP_ORDER, Icon, patternDomId, TILE_THEME, type TileThemeKey } from "@/theme";

import { EmptyState } from "./States";

import "./panels.css";

export interface PlayerDossierProps {
  /** The seat this card is about. */
  readonly player: PlayerView;
  /**
   * Every seat in `state.players` order.
   *
   * Needed for the seat *identity*, which is position-derived: `PlayerView.token` is a free-form
   * asset key whose names are neither `TOKEN_IDENTITY`'s six nor in its order, so using it would
   * mis-assign a shape (see `board/projection.ts`).
   */
  readonly players: readonly PlayerView[];
  /** The board, for square names and for filing an owned index under its band. */
  readonly board: BoardView | undefined;
  /** `state.properties`, indexed by tile. Read per square for houses and the mortgage flag. */
  readonly properties: readonly PropertyProjection[];
  /** `true` when this seat is the one to act. Presentation only. */
  readonly isCurrent?: boolean | undefined;
  /**
   * Make each square a real target that opens its detail.
   *
   * Omitted, the squares are a readout. Provided, they become ≥ 44 px buttons — which is the seam
   * GAP G-53 asks for: below the board's breakpoint a square is not a tap target, and selection
   * happens in a dossier list instead.
   */
  readonly onSelectSquare?: ((tile: number) => void) | undefined;
}

/** Every band a square can carry, in board travel order: the colour sets, then the two kinds. */
const ALL_KEYS: readonly TileThemeKey[] = [...GROUP_ORDER, "railroad", "utility"];

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/** One owned square, resolved for display. Every field is a lookup. */
interface Deed {
  readonly index: number;
  readonly name: string;
  readonly houses: number;
  readonly mortgaged: boolean;
}

/**
 * A colour band stood on its end, rimmed by the keyline.
 *
 * `bandFill` paints the colour *and* the pattern in one `fill`, so the spine physically cannot ship
 * the colour channel without the colourblind channel.
 */
function DeedSpine({ themeKey }: { readonly themeKey: TileThemeKey }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 6 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-testid="deed-spine"
      data-pattern={patternDomId(themeKey)}
      className="kesef-spine self-stretch"
    >
      <rect
        width={6}
        height={24}
        fill={bandFill(themeKey)}
        stroke="var(--color-hairline)"
        strokeWidth={0.5}
      />
    </svg>
  );
}

/**
 * One pip per square in the set, inked for the ones held.
 *
 * Both numbers are `GroupHoldings`'s. This is the same two figures the words carry, in a channel a
 * pre-reader can use — and deliberately *not* the source of the "Complete set" badge, which is a
 * separate projected boolean.
 */
function SetPips({
  owned,
  total,
  label,
}: {
  readonly owned: number;
  readonly total: number;
  readonly label: string;
}): React.JSX.Element {
  return (
    <span role="img" aria-label={label} data-testid="set-pips" className="flex items-center gap-px">
      {Array.from({ length: total }, (_, slot) => (
        <span key={slot} className="kesef-setpip" data-owned={slot < owned} />
      ))}
    </span>
  );
}

/** Houses as pips and a hotel as one wider block, exactly as a square draws them. */
function Development({ houses }: { readonly houses: number }): React.JSX.Element | null {
  if (houses <= 0) {
    return null;
  }
  // `HOTEL_LEVEL` is the engine's own constant, compared rather than derived — the same reading
  // `board/Tile.tsx` makes, and the reason a "5" never has to be interpreted here.
  const isHotel = houses >= HOTEL_LEVEL;
  return (
    <span
      aria-hidden="true"
      data-testid="deed-development"
      data-houses={houses}
      data-hotel={isHotel}
      className="flex items-center gap-px"
    >
      {isHotel ? (
        <span className="kesef-deed-hotel" />
      ) : (
        Array.from({ length: houses }, (_, pip) => <span key={pip} className="kesef-deed-house" />)
      )}
    </span>
  );
}

/** One square's row: name, what is built on it, whether it is mortgaged. */
function DeedRow({
  deed,
  onSelect,
  t,
}: {
  readonly deed: Deed;
  readonly onSelect: ((tile: number) => void) | undefined;
  readonly t: Translate;
}): React.JSX.Element {
  const marks = (
    <>
      <span className="min-w-0 flex-1 truncate">{deed.name}</span>
      <Development houses={deed.houses} />
      {deed.mortgaged && (
        <span className="kesef-deed-mortgage" title={undefined}>
          <span className="sr-only">{t("label.mortgaged")}</span>
          <span aria-hidden="true">&#8709;</span>
        </span>
      )}
    </>
  );

  return (
    <li data-testid="deed-row" data-tile={deed.index} className="flex items-center">
      {onSelect === undefined ? (
        <span className="flex w-full items-center gap-2 py-1 text-sm">{marks}</span>
      ) : (
        <button
          type="button"
          onClick={() => {
            onSelect(deed.index);
          }}
          aria-label={t("board.open_tile", { name: deed.name })}
          className="target focus-visible:z-10 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-start text-sm hover:bg-current/5"
        >
          {marks}
        </button>
      )}
    </li>
  );
}

/** One colour set: spine, icon, name, completion, and the squares held in it. */
function GroupRow({
  themeKey,
  holdings,
  deeds,
  onSelectSquare,
  t,
}: {
  readonly themeKey: TileThemeKey;
  /** `undefined` for railroads and utilities, which the projection ships no roll-up for. */
  readonly holdings: GroupHoldings | undefined;
  readonly deeds: readonly Deed[];
  readonly onSelectSquare: ((tile: number) => void) | undefined;
  readonly t: Translate;
}): React.JSX.Element {
  const theme = TILE_THEME[themeKey];
  const name = t(theme.nameKey);
  const progress =
    holdings === undefined
      ? undefined
      : holdings.complete
        ? t("dossier.complete_set")
        : t("dossier.set_progress", { owned: holdings.owned, total: holdings.total });

  return (
    <li
      data-testid="group-row"
      data-group={themeKey}
      data-complete={holdings?.complete ?? false}
      className="border-current/15 flex items-stretch gap-2 border-b py-2 last:border-b-0"
    >
      <DeedSpine themeKey={themeKey} />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <Icon name={theme.icon} size={16} className="shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>

          {progress !== undefined && holdings !== undefined && (
            <>
              <SetPips
                owned={holdings.owned}
                total={holdings.total}
                label={t("dossier.set_progress", {
                  owned: holdings.owned,
                  total: holdings.total,
                })}
              />
              <span
                data-testid="group-progress"
                className="text-xs font-semibold tabular-nums opacity-85"
                dir="ltr"
              >
                {progress}
              </span>
            </>
          )}
        </div>

        {holdings !== undefined && (holdings.houses > 0 || holdings.mortgaged_count > 0) && (
          <p className="flex flex-wrap items-center gap-3 text-xs opacity-80">
            {holdings.houses > 0 && (
              <span data-testid="group-houses">
                {t("label.houses")}{" "}
                <span dir="ltr" className="tabular-nums">
                  {holdings.houses}
                </span>
              </span>
            )}
            {holdings.mortgaged_count > 0 && (
              <span data-testid="group-mortgaged">
                {t("label.mortgaged")}{" "}
                <span dir="ltr" className="tabular-nums">
                  {holdings.mortgaged_count}
                </span>
              </span>
            )}
          </p>
        )}

        {deeds.length > 0 && (
          <ul className="border-current/20 flex flex-col border-s ps-2">
            {deeds.map((deed) => (
              <DeedRow key={deed.index} deed={deed} onSelect={onSelectSquare} t={t} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** A labelled figure. `dir="ltr"` keeps Latin numerals reading left-to-right in Hebrew (G-43). */
function Figure({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[0.625rem] font-semibold tracking-[0.12em] uppercase opacity-65">
        {label}
      </span>
      <span data-testid={testId} dir="ltr" className="text-base font-bold tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function PlayerDossier({
  player,
  players,
  board,
  properties,
  isCurrent = false,
  onSelectSquare,
}: PlayerDossierProps): React.JSX.Element {
  const { t, i18n } = useTranslation();

  const translate: Translate = (key, params) => t(key, params ?? {});

  /**
   * The owned squares, filed under their band.
   *
   * A lookup and a bucket, and the only thing the board is used for. Note what is *not* derived
   * from this map: no completion, no total, no count of a set. Those are `group_holdings`'s, and
   * this map exists so that a square's *name* is printed under the right heading.
   */
  const deedsByKey = useMemo(() => {
    const filed = new Map<TileThemeKey, Deed[]>();
    if (board === undefined) {
      return filed;
    }
    const byIndex = new Map<number, TileView>(board.tiles.map((tile) => [tile.index, tile]));

    for (const index of player.tiles_owned) {
      const tile = byIndex.get(index);
      if (tile === undefined) {
        continue;
      }
      const key = tileThemeKey(tile);
      if (key === null) {
        continue;
      }
      const nameKey = `board-${board.id}:${tile.name_key}`;
      const property = properties[index];
      const bucket = filed.get(key) ?? [];
      bucket.push({
        index,
        // Same guarded lookup as the event log and the action bar: `board-israel` is a declared
        // board with no catalogue until MON-503, and `missingKeyHandler` throws under test by
        // design (GAP G-46/G-F17). One unnamed square must not take the whole card down.
        name: i18n.exists(nameKey) ? t(nameKey) : t("label.unknown_square"),
        houses: property?.houses ?? 0,
        mortgaged: property?.mortgaged ?? false,
      });
      filed.set(key, bucket);
    }
    return filed;
  }, [board, player.tiles_owned, properties, t, i18n]);

  const seat = seatOf(players, player.id);

  /**
   * The bands that hold deeds but no roll-up.
   *
   * Railroads and utilities always land here, because `GroupHoldings.group` is typed `ColorGroup`
   * and the projection ships no roll-up for either — that is a contract gap, filed rather than
   * papered over with an invented "1 of 4".
   *
   * It is deliberately computed as "has deeds, has no `group_holdings` entry" rather than as the
   * fixed pair, so a square can never be silently dropped. `PlayerView.group_holdings` is
   * documented as always all eight, but a dossier that hides a deed the moment that stops being
   * true is a dossier that lies about what a player owns — and losing a holding is a worse failure
   * than showing it without a fraction.
   */
  const rolledUp = new Set<TileThemeKey>(player.group_holdings.map((entry) => entry.group));
  const others = ALL_KEYS.filter(
    (key) => !rolledUp.has(key) && (deedsByKey.get(key) ?? []).length > 0,
  );

  return (
    <section
      data-testid="player-dossier"
      data-player={player.id}
      data-current={isCurrent}
      aria-label={t("dossier.title", { name: player.name })}
      className={[
        "bg-tile text-ink border-hairline flex min-w-0 flex-col gap-3 rounded-2xl border p-3",
        "shadow-[0_2px_0_0_oklch(0%_0_0/0.10),0_10px_24px_-12px_oklch(0%_0_0/0.45)]",
        isCurrent ? "ring-2 ring-current/30" : "",
        player.bankrupt ? "opacity-70 saturate-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="flex items-center gap-3">
        {seat !== undefined && <Token seat={seat} size={TOKEN_PX.heading} isCurrent={isCurrent} />}
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-base font-bold">{player.name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-[0.625rem] font-semibold tracking-[0.1em] uppercase opacity-70">
            {seat !== undefined && <span>{t("dossier.seat", { seat })}</span>}
            {player.is_bot && <span data-testid="dossier-bot">{t("dossier.bot")}</span>}
            {player.in_jail && <span data-testid="dossier-jailed">{t("label.in_jail")}</span>}
            {player.bankrupt && <span data-testid="dossier-bankrupt">{t("label.bankrupt")}</span>}
          </p>
        </div>
      </header>

      <div className="border-current/15 grid grid-cols-2 gap-3 border-y py-2 sm:grid-cols-4">
        <Figure label={t("label.cash")} value={player.cash} testId="dossier-cash" />
        <Figure label={t("label.net_worth")} value={player.net_worth} testId="dossier-net-worth" />
        <Figure
          label={t("label.properties")}
          value={player.tiles_owned.length}
          testId="dossier-squares"
        />
        <Figure
          label={t("label.jail_cards")}
          value={player.jail_cards.length}
          testId="dossier-jail-cards"
        />
      </div>

      {player.tiles_owned.length === 0 && <EmptyState messageKey="dossier.empty" />}

      {/*
        The deed list folds away, and starts folded (owner feedback on the first playable build: the
        card left no room for the history beside it).

        Only this part folds. The header and the four figures — cash, net worth, squares, jail cards —
        stay open, because those are what a player checks between moves; hiding them to make room
        would trade the information people read constantly for the information they read occasionally.
        The deed list is also the part that *grows*: it is what squeezes the log out of the column by
        turn thirty, so folding it is what actually buys the room.

        A native `<details>` rather than a `useState` toggle: it is keyboard-operable, exposed to a
        screen reader as an expandable group, findable by in-page search even while closed, and it
        holds its own state — none of which a div with an `onClick` gets for free.
      */}
      <details className="group min-w-0">
        <summary className="target -mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-1 text-[0.625rem] font-semibold tracking-[0.12em] uppercase opacity-65 hover:opacity-100">
          {/*
            Plus and minus, swapped by `group-open`, rather than a chevron that rotates. A chevron
            has to point along the inline axis, and CSS transforms have no logical variant — the
            `rtl:-scale-x-*` needed to mirror one is in the physical-property deny list for exactly
            that reason. A vertical-symmetric pair needs no mirroring in the first place.
          */}
          <Icon name="plus" size={12} className="shrink-0 group-open:hidden" />
          <Icon name="minus" size={12} className="hidden shrink-0 group-open:block" />
          {t("label.properties")}
          <span className="tabular-nums opacity-80">
            {t("label.squares", { count: player.tiles_owned.length })}
          </span>
        </summary>

        {/*
          `group_holdings` in the order the server sent it — all eight colour groups, always, which is
          what keeps two dossiers side by side aligned in the compare case. Not sorted, not filtered:
          "0 of 3" is real information about a set that is still wide open.
        */}
        <ul className="mt-2 flex flex-col">
          {player.group_holdings.map((holdings) => (
            <GroupRow
              key={holdings.group}
              themeKey={holdings.group}
              holdings={holdings}
              deeds={deedsByKey.get(holdings.group) ?? []}
              onSelectSquare={onSelectSquare}
              t={translate}
            />
          ))}
        </ul>

        {others.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-[0.625rem] font-semibold tracking-[0.12em] uppercase opacity-65">
              {t("dossier.other_holdings")}
            </h3>
            {/*
            No completion figure here, and that is a contract gap rather than a design choice:
            `GroupHoldings.group` is typed `ColorGroup`, so the projection ships no roll-up for the
            four railroads or the two utilities even though both sets change what rent is owed. The
            honest rendering is the squares without a fraction — inventing "2 of 4" would be
            counting a set, which is the one thing this file must not do.
          */}
            <ul className="flex flex-col">
              {others.map((key) => (
                <GroupRow
                  key={key}
                  themeKey={key}
                  holdings={undefined}
                  deeds={deedsByKey.get(key) ?? []}
                  onSelectSquare={onSelectSquare}
                  t={translate}
                />
              ))}
            </ul>
          </div>
        )}
      </details>
    </section>
  );
}
