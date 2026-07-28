/**
 * A seat's playing piece, and the answer to what happens when six of them land on one square.
 *
 * The identity — shape, colour, icon — is `TOKEN_IDENTITY`'s and only ever read from there
 * (MON-412, GAP G-A2/G-51). Nothing in this file picks a colour, and nothing invents a seventh
 * piece: `tokenForSeat` throws on one, because two players behind one shape is worse than a
 * crash.
 *
 * ## Crowding, solved by arithmetic rather than by hope
 *
 * Six tokens can share a square, and a square on a 320 px board is about 29 px. There is no
 * arrangement in which six legible pieces fit inside 29 px, so the honest design is a *ladder*
 * that degrades one channel at a time and never overlaps:
 *
 * 1. **Cluster.** Pieces sit in a grid of one, two or three columns — never stacked, never
 *    overlapping, so no piece is ever hidden behind another.
 * 2. **Drop the icon.** Below {@link ICON_MIN_PX} the rider is a smudge, so it is not drawn at
 *    all. Shape and colour both survive to well under 12 px, and shape is the primary channel
 *    precisely so this step costs nothing that matters.
 * 3. **Collapse to a leader and a count.** Below {@link TOKEN_MIN_PX} per piece the cluster
 *    itself stops being legible, so one piece is drawn and the rest become a `+N` chip.
 *
 * Step 3 hides identities, so it is paired with a guarantee: the *full* occupant list is always
 * in the tile's accessible name, whatever the geometry did. A sighted player on a tiny screen
 * reads the count and opens the tile; a screen-reader user hears every name either way. What is
 * never allowed is the failure this ladder exists to prevent — two pieces drawn on top of each
 * other, where the board simply lies about who is standing there.
 *
 * {@link planCluster} is pure and separately tested, so the ladder is arithmetic in a unit test
 * rather than a judgement about a screenshot.
 */

import { ICON_PATH, ICON_VIEWBOX, tokenForSeat, TOKEN_SHAPE_PATH, type SeatNumber } from "@/theme";

/** Below this, a rider icon is a smudge. Shape and colour carry on alone. */
export const ICON_MIN_PX = 18;

/** Below this, a piece stops reading as a shape at all and the cluster collapses. */
export const TOKEN_MIN_PX = 11;

/** Share of a tile's inline size the token rail may use. The rest is the label and the band. */
const RAIL_FRACTION = 0.86;

/** Gap between pieces, in px. One px of felt is enough to separate two silhouettes. */
const CLUSTER_GAP_PX = 1;

export interface TokenOccupant {
  readonly seat: SeatNumber;
  /** The player's own name, from `state.players`. The theme deliberately has no name for a seat. */
  readonly name: string;
  readonly isCurrent: boolean;
}

export interface ClusterPlan {
  readonly columns: number;
  /** Edge of one piece, in CSS px. */
  readonly tokenPx: number;
  /** How many pieces are drawn as themselves. */
  readonly shown: number;
  /** How many are represented by the `+N` chip instead. Zero unless the cluster collapsed. */
  readonly overflow: number;
  /** Whether each drawn piece is large enough to carry its rider icon. */
  readonly withIcon: boolean;
}

/**
 * How to arrange `count` pieces inside a tile of `tileInlineSize` px.
 *
 * An unmeasured tile (`tileInlineSize <= 0`, which is every tile in jsdom and every tile on the
 * first paint) plans the *full* cluster at the minimum size. That is the fail-safe direction: it
 * shows every identity rather than collapsing them away on the strength of a measurement that
 * has not happened yet.
 */
export function planCluster(count: number, tileInlineSize: number): ClusterPlan {
  if (count <= 0) {
    return { columns: 0, tokenPx: 0, shown: 0, overflow: 0, withIcon: false };
  }
  const columns = count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rail = tileInlineSize * RAIL_FRACTION;
  const unmeasured = tileInlineSize <= 0;
  const fitted = Math.floor(rail / columns) - CLUSTER_GAP_PX;
  const tokenPx = unmeasured ? TOKEN_MIN_PX : fitted;

  if (!unmeasured && tokenPx < TOKEN_MIN_PX && count > 1) {
    // Step 3. One piece at a size that can actually be seen, and an honest count for the rest.
    const soloPx = Math.max(Math.floor(rail * 0.55), 1);
    return {
      columns: 1,
      tokenPx: soloPx,
      shown: 1,
      overflow: count - 1,
      withIcon: soloPx >= ICON_MIN_PX,
    };
  }

  return {
    columns,
    tokenPx: Math.max(tokenPx, 1),
    shown: count,
    overflow: 0,
    withIcon: tokenPx >= ICON_MIN_PX,
  };
}

export interface TokenProps {
  readonly seat: SeatNumber;
  /**
   * Accessible name, normally the player's own. Omit inside something that already names its
   * occupants — a second name on the piece would say the same thing twice.
   */
  readonly label?: string | undefined;
  /** Edge in CSS px. */
  readonly size?: number;
  /** Draw the rider icon. Off below {@link ICON_MIN_PX}; see the module docstring. */
  readonly withIcon?: boolean;
  /** The acting seat sits a little higher off the felt. */
  readonly isCurrent?: boolean;
  readonly className?: string;
}

/**
 * One piece: a coloured plinth in the seat's shape, with its rider on top.
 *
 * The rider is scaled and centred with an SVG `transform`, which is geometry inside the SVG
 * coordinate system and therefore has no inline axis to mirror — unlike a CSS `translate`, which
 * is why that one is in the lint's deny list and this one is not.
 */
export function Token({
  seat,
  label,
  size = 24,
  withIcon = true,
  isCurrent = false,
  className,
}: TokenProps): React.JSX.Element {
  const identity = tokenForSeat(seat);
  const named = label !== undefined;
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      className={`${isCurrent ? "drop-shadow-md" : "drop-shadow-sm"} ${className ?? ""}`}
      focusable="false"
      role={named ? "img" : undefined}
      aria-label={label}
      aria-hidden={named ? undefined : true}
    >
      <path
        d={TOKEN_SHAPE_PATH[identity.shape]}
        fill={identity.color}
        stroke="var(--color-hairline)"
        strokeWidth={isCurrent ? 2 : 1.2}
      />
      {withIcon && (
        <g transform="translate(6.6 6.6) scale(0.45)">
          <path d={ICON_PATH[identity.icon]} fill={identity.onColor} fillRule="evenodd" />
        </g>
      )}
    </svg>
  );
}

export interface TokenClusterProps {
  readonly occupants: readonly TokenOccupant[];
  /** Measured inline size of the tile in CSS px; `0` before the board has been measured. */
  readonly tileInlineSize: number;
  /** Rendered for the `+N` chip. Called with the number of pieces the chip stands for. */
  readonly overflowLabel: (hidden: number) => string;
}

/**
 * Every piece standing on one square, arranged by {@link planCluster}.
 *
 * `aria-hidden` in full: the tile that contains this already names its occupants, and a piece
 * that announced itself would make a crowded square say six names twice.
 */
export function TokenCluster({
  occupants,
  tileInlineSize,
  overflowLabel,
}: TokenClusterProps): React.JSX.Element | null {
  if (occupants.length === 0) {
    return null;
  }
  const plan = planCluster(occupants.length, tileInlineSize);
  // The acting seat is drawn first so that it is the one piece kept when the cluster collapses.
  const ordered = [...occupants].sort(
    (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.seat - b.seat,
  );
  const drawn = ordered.slice(0, plan.shown);

  return (
    <div
      aria-hidden="true"
      data-testid="token-cluster"
      data-columns={plan.columns}
      data-overflow={plan.overflow}
      className="grid justify-items-center gap-px"
      style={{ gridTemplateColumns: `repeat(${String(plan.columns)}, minmax(0, 1fr))` }}
    >
      {drawn.map((occupant) => (
        <Token
          key={occupant.seat}
          seat={occupant.seat}
          size={plan.tokenPx}
          withIcon={plan.withIcon}
          isCurrent={occupant.isCurrent}
        />
      ))}
      {plan.overflow > 0 && (
        <span
          data-testid="token-overflow"
          className="bg-tile text-ink border-hairline rounded-full border px-1 text-[0.55rem] font-bold tabular-nums"
        >
          {overflowLabel(plan.overflow)}
        </span>
      )}
    </div>
  );
}
