/**
 * One square: a printed card face, rotated to its edge.
 *
 * ## Everything shown here is a field, not a conclusion
 *
 * `owner`, `houses` and `mortgaged` are read straight off `state.properties[index]`. Nothing here
 * counts a colour set, works out whether a house *could* be built, decides what rent would be, or
 * infers that five houses means a hotel from a rule about building — `HOTEL_LEVEL` is the engine's
 * own constant and `houses` is compared against it. A square that wanted a figure the projection
 * does not ship would be a contract gap to file, not an expression to add (ADR-005, ADR-008).
 *
 * ## Why the face is authored once and rotated
 *
 * The band sits at `block-start` and the angle comes from `geometry.ts`, which keeps it facing the
 * board's interior on all four edges — the same rigid rotation a cardboard board uses. The *text*
 * inside then restores the document direction with `dir="inherit"`, so a Hebrew square name reads
 * right-to-left inside a grid that does not mirror. That split is the whole of the G-44 resolution:
 * the grid is geometry and does not flip; the words are language and do.
 *
 * ## The colourblind and pre-reader channels are not optional
 *
 * `bandFill` paints the group's colour *and* its pattern in a single `fill`, so a band physically
 * cannot ship one without the other. Railroads and utilities get the same treatment — the engine
 * leaves their `group` null, and six ownable squares identified by text alone is the same defect as
 * colour alone (GAP G-A3/G-52). `tileThemeKey` returns `null` for a square nobody can own, which is
 * a deliberate absence rather than a fallback: painting Free Parking brown would be worse than
 * painting it plain.
 *
 * ## Nothing here is hover-only
 *
 * No `title` tooltips. The houses, the hotel, the mortgage flag and every occupant are all in the
 * square's accessible name, and the same facts belong to the tile-detail sheet the caller opens on
 * Enter (§5.5 forbids hover-only reveals, and a tooltip is one).
 */

// The file, not `@/animation` — one presentational leaf rather than the barrel, which is what keeps
// this out of a cycle: `animation/index.ts` re-exports the hook, and the hook reaches `@/game`.
import { Pop } from "@/animation/Beat";
import { bandFill, BuildingFigure, patternDomId, tokenForSeat, type TileThemeKey } from "@/theme";

import type { TileRotation } from "./geometry";
import {
  HOTEL_LEVEL,
  tileThemeKey,
  type PropertyProjection,
  type TileProjection,
} from "./projection";
import { TokenCluster, type TokenOccupant } from "./Token";
import { useMoney } from "@/i18n";

/** Tailwind's rotation utilities, keyed by the angle `geometry.ts` computed. */
const ROTATION_CLASS: Readonly<Record<TileRotation, string>> = {
  0: "rotate-0",
  90: "rotate-90",
  180: "rotate-180",
  270: "-rotate-90",
};

export interface TileProps {
  readonly tile: TileProjection;
  /** `state.properties[tile.index]`, or `undefined` for a square nobody can own. */
  readonly property: PropertyProjection | undefined;
  /** The owner's seat, for the ownership marker. `undefined` while the bank holds it. */
  readonly ownerSeat: SeatOf | undefined;
  readonly occupants: readonly TokenOccupant[];
  readonly rotation: TileRotation;
  readonly isCorner: boolean;
  /** Measured inline size of this square in CSS px, for the token crowding ladder. */
  readonly inlineSize: number;
  /** Translated square name. */
  readonly name: string;
  /** The square's whole accessible name, assembled by `describeTile`. */
  readonly description: string;
  /** Translated `+N` for a collapsed token cluster. */
  readonly overflowLabel: (hidden: number) => string;
  /**
   * The animation queue's beat for this square (MON-701). A bump pops the houses.
   *
   * Presentation only, and `houses` is drawn from the projection whatever this is: a square with
   * three houses shows three houses at the first paint, with or without a beat.
   */
  readonly popNonce?: number | undefined;
  /** `true` once the board is wide enough for a 44 px target; see `geometry.ts`. */
  readonly interactive: boolean;
  /** The roving tab stop, or the active descendant when the board is too narrow to rove. */
  readonly isActive: boolean;
  readonly domId: string;
  readonly ariaColIndex: number;
}

type SeatOf = TokenOccupant["seat"];

/**
 * The colour band, painted with its group's pattern.
 *
 * A tiny `<svg>` per square rather than a CSS gradient, because the pattern definitions live in the
 * one `<ThemeSprite/>` at the app root and `url(#id)` resolves document-wide — ten patterns parsed
 * once instead of forty times.
 */
function GroupBand({ themeKey }: { themeKey: TileThemeKey }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 6"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-testid="group-band"
      data-pattern={patternDomId(themeKey)}
      className="block h-[22%] w-full"
    >
      <rect
        width={24}
        height={6}
        fill={bandFill(themeKey)}
        stroke="var(--color-hairline)"
        strokeWidth={0.6}
      />
    </svg>
  );
}

/**
 * What is built on the street, drawn as buildings (MON-710).
 *
 * A row of cottages standing on a common ground line, or one stepped block. The figures are the
 * theme's (`theme/buildings.tsx`) and the size is `.kesef-tile-buildings`', which sizes them from
 * the square's own inline size — so this component decides *how many* and nothing else.
 *
 * `houses` is read off the projection and compared against the engine's own `HOTEL_LEVEL`. Nothing
 * here counts a colour set, works out whether a fifth house is legal, or turns "5" into "hotel" by
 * a rule of its own — the comparison against a named engine constant is a lookup, and a lookup is
 * all a square is allowed (ADR-005, ADR-008).
 */
function Development({ houses }: { houses: number }): React.JSX.Element | null {
  if (houses <= 0) {
    return null;
  }
  const isHotel = houses >= HOTEL_LEVEL;
  return (
    <span
      data-testid="development"
      data-houses={houses}
      data-hotel={isHotel}
      aria-hidden="true"
      // `items-end` puts every roof at a different height only if the figures differ in size, which
      // they do not within a row — what it buys is a shared ground line, so a row of houses reads as
      // houses standing on a street rather than as marks floating in a band.
      className="kesef-tile-buildings flex items-end justify-center gap-px"
    >
      {isHotel ? (
        <BuildingFigure level="hotel" />
      ) : (
        Array.from({ length: houses }, (_, slot) => <BuildingFigure key={slot} level="house" />)
      )}
    </span>
  );
}

export function Tile({
  tile,
  property,
  ownerSeat,
  occupants,
  rotation,
  isCorner,
  inlineSize,
  name,
  description,
  overflowLabel,
  popNonce,
  interactive,
  isActive,
  domId,
  ariaColIndex,
}: TileProps): React.JSX.Element {
  const money = useMoney();
  const themeKey = tileThemeKey(tile);
  const houses = property?.houses ?? 0;
  const mortgaged = property?.mortgaged ?? false;

  return (
    <div
      id={domId}
      role="gridcell"
      aria-colindex={ariaColIndex}
      aria-label={description}
      aria-selected={isActive}
      data-tile-index={tile.index}
      data-active={isActive}
      // `tabIndex` roves only where a square is allowed to be a hit target at all. Below the
      // breakpoint every square is -1 and the grid itself holds the single tab stop — `Board.tsx`
      // owns that decision and the arithmetic behind it (GAP G-C1/G-E2).
      tabIndex={interactive && isActive ? 0 : -1}
      className={[
        "kesef-tile border-hairline bg-tile text-ink relative flex flex-col overflow-hidden border",
        // A square is its own container so the type scale and the crowding ladder can both be
        // expressed against the square's own width rather than the whole board's.
        "@container",
        isCorner ? "rounded-lg" : "rounded-sm",
        interactive ? "target cursor-pointer" : "",
        mortgaged ? "opacity-85 saturate-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={`flex h-full w-full flex-col ${ROTATION_CLASS[rotation]}`}>
        {themeKey !== null && <GroupBand themeKey={themeKey} />}

        {/*
          `dir="inherit"` is the other half of the G-44 exception: the grid around this does not
          mirror, and the words inside it must. See the pinned `dir="ltr"` in `Board.tsx`.
        */}
        <div
          dir="inherit"
          className="flex min-h-0 flex-1 flex-col items-center justify-between p-[3%] text-center"
        >
          <span className="text-[13cqw] leading-none font-semibold uppercase">{name}</span>

          <span className="flex flex-col items-center gap-px">
            {/* The marks are already correct; the beat only decides whether they arrive with a
                flourish (MON-701). `<Pop>` with no beat is a bare wrapper. */}
            <Pop nonce={popNonce}>
              <Development houses={houses} />
            </Pop>
            {mortgaged && (
              // A glyph rather than a word: at 29 px there is room for one character. The word is
              // in the square's accessible name and in its detail sheet.
              <span data-testid="mortgaged" aria-hidden="true" className="kesef-mortgaged">
                &#8709;
              </span>
            )}
            {tile.price !== null && tile.price !== undefined && (
              // Latin numerals stay LTR inside a Hebrew page (GAP G-43), and carry the language's
              // currency since MON-720 — a price on a square and a price in the log now agree.
              <span dir="ltr" className="text-[11cqw] leading-none tabular-nums opacity-75">
                {money(tile.price)}
              </span>
            )}
          </span>
        </div>

        {ownerSeat !== undefined && (
          // The owner's own plinth colour, so "the triangle owns this street" is legible without
          // reading the name underneath. One source of truth: `TOKEN_IDENTITY`.
          <span
            data-testid="ownership-marker"
            data-owner-seat={ownerSeat}
            aria-hidden="true"
            className="border-hairline block h-[10%] w-full border-t"
            style={{ backgroundColor: tokenForSeat(ownerSeat).color }}
          />
        )}
      </div>

      {occupants.length > 0 && (
        <span className="pointer-events-none absolute inset-[8%] flex items-end justify-center">
          <TokenCluster
            occupants={occupants}
            tileInlineSize={inlineSize}
            overflowLabel={overflowLabel}
          />
        </span>
      )}
    </div>
  );
}
