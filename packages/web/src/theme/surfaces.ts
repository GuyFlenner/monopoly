/**
 * Named surfaces, and the keyline that makes the accessibility floor reachable.
 *
 * ## Why these names exist
 *
 * "Contrast ≥ 3:1" is meaningless without saying *against what*. The old band comment claimed
 * 3:1 and measured 1.41:1, because it never named its reference surface (GAP §5, G-B1). Every
 * ratio this theme claims is quoted against one of the surfaces below, by name, in
 * `contrast.test.ts`.
 *
 * ## The keyline — the one idea this theme spends its boldness on
 *
 * A band's edge cannot be carried by its fill. Yellow at `#f2d024` has a relative luminance of
 * 0.65; against any surface light enough to read black text on, its maximum contrast is about
 * 1.4:1, and the only yellow that reaches 3:1 against a card face is a dark olive that is no
 * longer yellow. Real boards have always solved this the same way, with a printed keyline: a
 * near-black hairline drawn around every painted area. So every painted surface in this
 * theme — colour bands, seat tokens, buttons, the cards themselves — is rimmed with
 * `hairline`, and *that* is the token gated at ≥ 3:1. The fill is then free to be the group's
 * actual colour, and the boundary is still visible to everyone.
 *
 * `hairline` is gated against **both** `tile` and `table`, because a rimmed thing may sit on a
 * card face or on the felt. In the light theme that forces it to near-black; in the dark theme
 * it inverts to a warm bone. It is not gated against the band it rims — a keyline separates
 * the band from the *surface*, and an edge is visible as long as one of the two regions it
 * divides contrasts with it.
 *
 * ## The quiet tier is a colour, not an opacity (MON-743)
 *
 * `onTableMuted`, `inkMuted` and `edge` exist because the thing they replace — `text-ink
 * opacity-60` — is not a colour at all. It is a colour plus a compositing step, and the compositing
 * step happens in the browser, where the gate cannot follow it. Measured against the shipped
 * palette, the composites were `onTable@0.8` on the felt = 3.94:1, `ink@0.6` on a card = 4.38:1,
 * `onTable@0.55` = 2.70:1 and `border-current/30` = 1.91:1 — all under their floors, while
 * `contrast.test.ts` reported green because it was measuring the solid `ink` the markup *names*.
 * A named solid can be measured; an alpha cannot, so the tier is named solids.
 *
 * ## Why there is one quiet tier on the felt and not two
 *
 * The obvious design has `muted` and a fainter `faint` below it. The felt cannot carry it. Full
 * `onTable` on the light felt measures **5.13:1** — that is the whole budget, and 4.5:1 of it is
 * spent before any quieting begins, so every legible quiet ink on the light felt lands in a band
 * about a tenth of a ratio point wide. (The dark felt has 13.65:1 and would separate two tiers
 * comfortably; a token that is two tiers in one theme and one in the other is a token that means
 * different things in different themes.) So there is one `onTableMuted`, and the auction's
 * withdrawn bidder — the one place that wanted a fainter third tier — carries its state on the
 * channels that survive the measurement instead: a strike-through, a cross glyph and the seat
 * token, which now stays at full strength and is easier to recognise than it was under the dim.
 *
 * ## The focus ring is a sandwich, and provably sufficient
 *
 * §5.5 asks for a focus ring "contrast-tested against every surface it can sit on". No single
 * colour can do that: a ring that clears 3:1 against yellow (L 0.65) needs L ≤ 0.18, and one
 * that clears 3:1 against dark blue (L 0.10) needs L ≥ 0.39. So the ring is two concentric
 * rings, one near-black and one near-white, and the gate is that *at least one* of them clears
 * 3:1 against each surface. That is not merely satisfiable, it is unconditional: for any
 * surface luminance L, the near-white ring works whenever L ≤ 0.29 and the near-black ring
 * works whenever L ≥ 0.13, and those two ranges overlap, so every possible surface is covered.
 * `contrast.test.ts` checks it against the concrete list anyway.
 *
 * Values are duplicated in `src/index.css`, which is where the browser reads them from.
 * `surfaces.test.ts` parses that file and fails if the two ever disagree, so the duplication
 * cannot rot.
 */

export const THEMES = ["light", "dark"] as const;
export type ThemeName = (typeof THEMES)[number];

export interface Surfaces {
  /** The felt playing surface the board sits on. */
  readonly table: string;
  /** Ink for text placed directly on the felt. */
  readonly onTable: string;
  /** The quiet tier on the felt. Text, so it is gated at 4.5:1 against `table`. */
  readonly onTableMuted: string;
  /** A card face: tiles, dossiers, panels, buttons. The default reference surface. */
  readonly tile: string;
  /** Ink for text placed on a card face. */
  readonly ink: string;
  /** The quiet tier on a card face. Text, so it is gated at 4.5:1 against `tile`. */
  readonly inkMuted: string;
  /**
   * A control's own edge — an input rim, a ghost button's outline.
   *
   * Non-text, so 3:1. Distinct from `hairline`, which is the near-black keyline a *painted* area is
   * rimmed with; an edge drawn at keyline strength around every text input turns a form into a
   * grid. This is the softest line that still measures.
   */
  readonly edge: string;
  /** The keyline. See the module docstring. */
  readonly hairline: string;
}

export const SURFACES: Readonly<Record<ThemeName, Surfaces>> = {
  light: {
    table: "#33754f",
    onTable: "#f2f8f3",
    onTableMuted: "#e3eee6",
    tile: "#fbf6ec",
    ink: "#1f1b16",
    inkMuted: "#6c6861",
    edge: "#918d85",
    hairline: "#1c1712",
  },
  dark: {
    table: "#10281c",
    onTable: "#e8f2ea",
    onTableMuted: "#a7b5ac",
    tile: "#332d26",
    ink: "#f6efe2",
    inkMuted: "#b2aba0",
    edge: "#7d776d",
    hairline: "#b3a692",
  },
};

/**
 * The browser's own page background, which the theme does not own but must survive.
 *
 * `:root { color-scheme: light dark }` and no `background-color` anywhere means the setup screen —
 * the first screen anybody sees — sits on the user agent's `Canvas`, not on `tile`. Naming it here
 * is the same discipline as naming every other reference surface: a ratio quoted against "the page"
 * is a ratio quoted against nothing.
 *
 * Light is exactly `#ffffff` in every engine. Dark is not standardised: Chrome ships `#121212`,
 * Firefox `#1c1b22`, Safari `#1e1e1e`. The value below is the *lightest* of the three, which is the
 * worst case for the light inks that sit on it, and `contrast.test.ts` additionally sweeps the whole
 * range from black up to it rather than trusting one browser's constant.
 */
export const UA_CANVAS: Readonly<Record<ThemeName, string>> = {
  light: "#ffffff",
  dark: "#1e1e1e",
};

/** Both rings, in both themes. Theme-invariant by design — see the module docstring's proof. */
export const FOCUS_RING = {
  inner: "#101a2e",
  outer: "#fffdf7",
} as const;

/** The CSS custom property each surface slot ships as. Keeps the CSS/TS parity test honest. */
export const SURFACE_CSS_VAR: Readonly<Record<keyof Surfaces, string>> = {
  table: "--color-table",
  onTable: "--color-on-table",
  onTableMuted: "--color-on-table-muted",
  tile: "--color-tile",
  ink: "--color-ink",
  inkMuted: "--color-ink-muted",
  edge: "--color-edge",
  hairline: "--color-hairline",
};

export const FOCUS_CSS_VAR: Readonly<Record<keyof typeof FOCUS_RING, string>> = {
  inner: "--color-focus-inner",
  outer: "--color-focus-outer",
};

/** Minimum hit target, in CSS pixels. Mirrored by the `.target` utility in `index.css`. */
export const MIN_TARGET_PX = 44;

/**
 * The comfortable hit target a kids game steps up to (MON-604).
 *
 * 44 px is a *floor* — the smallest control WCAG 2.5.5 and §5.5 will accept, sized for an adult
 * who is aiming. A six-year-old is not aiming, and the honest response to that is not a second set
 * of components but a bigger number in the same place: `.target` reads
 * {@link TARGET_CSS_VAR} and `[data-comfort="kids"]` sets it, so every control in the product —
 * chits, seat pickers, dice toggles, dialog buttons, the trade panel's cash steppers — grows
 * together and none of them can be forgotten.
 *
 * 56 rather than 48: 48 is the next conventional step and is barely a change, and rather than 64,
 * which stops three controls fitting across a 320 px phone.
 */
export const KIDS_TARGET_PX = 56;

/**
 * The custom property `.target` sizes itself from. Declared so `surfaces.test.ts` can hold
 * `index.css` to the two numbers above rather than to a literal it also spells out.
 */
export const TARGET_CSS_VAR = "--kesef-target";

/** The attribute that switches the comfort scale, set once on the game screen's outermost box. */
export const COMFORT_ATTRIBUTE = "data-comfort";

/** The value of {@link COMFORT_ATTRIBUTE} that steps the scale up. */
export const KIDS_COMFORT = "kids";
