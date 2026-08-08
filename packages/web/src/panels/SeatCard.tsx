/**
 * One seat, as the setup screen lets a family edit it.
 *
 * Moved out of `SetupScreen.tsx` in MON-747, where it was the largest of the pieces below a
 * thousand-line form. The seat's *model* came with it — what a draft seat is, what the six
 * identities are, and how many rows there can therefore be — because those exist to describe this
 * row and nothing else in the package reads them. The screen imports them back.
 *
 * Nothing here changed in the move except the `export` keywords and the import of `Choice` and
 * `Picker`, which are now the sibling both this file and the screen share.
 */

import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { SeatConfig } from "@/api";
import type { Locale } from "@/i18n";

import { Choice, Picker } from "./SetupFields";

// --- Seat identities --------------------------------------------------------

/**
 * TODO(MON-412): replace with the six token identities from `@/theme/tokens`.
 *
 * MON-412 owns "six token identities = shape + colour + icon, one source of truth reused by
 * board, turn indicator, dossiers and auction list", and it is being built in parallel — so
 * this is a deliberately minimal local stand-in rather than a second opinion in the sibling's
 * territory. Swapping it out should be a one-line import change: everything below reads
 * `TOKEN_IDENTITIES` and nothing reads a shape or a colour directly.
 *
 * The pieces are ordinary objects on purpose. `SeatConfig.token` is a free-form string on the
 * wire, and the trademarked product's tokens are its trade dress; these are original, and each
 * silhouette is distinguishable from the others and from every colour-group icon in
 * `theme/groups.ts` (no acorn, no star — those are taken).
 */
interface TokenIdentity {
  /** The value posted as `SeatConfig.token`. */
  readonly token: string;
  readonly nameKey: string;
  /** An SVG path in a 32×32 box. Shape is the channel that survives greyscale. */
  readonly shape: string;
  readonly color: string;
  readonly icon: string;
}

const CIRCLE = "M16 3a13 13 0 1 0 0 26a13 13 0 1 0 0-26Z";
const SQUARE = "M6 4h20a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z";
const TRIANGLE = "M16 3 30 28H2Z";
const DIAMOND = "M16 2 30 16 16 30 2 16Z";
const HEXAGON = "M16 2 28 9v14l-12 7L4 23V9Z";
const SHIELD = "M16 2 29 7v11c0 7-6 11-13 13C9 29 3 25 3 18V7Z";

export const TOKEN_IDENTITIES: readonly TokenIdentity[] = [
  { token: "kite", nameKey: "token.kite", shape: TRIANGLE, color: "#d64550", icon: "🪁" },
  { token: "drum", nameKey: "token.drum", shape: CIRCLE, color: "#f0a021", icon: "🥁" },
  { token: "boat", nameKey: "token.boat", shape: DIAMOND, color: "#2f7fd6", icon: "⛵" },
  { token: "rocket", nameKey: "token.rocket", shape: SHIELD, color: "#7a4fd6", icon: "🚀" },
  { token: "bicycle", nameKey: "token.bicycle", shape: HEXAGON, color: "#2f9e58", icon: "🚲" },
  { token: "umbrella", nameKey: "token.umbrella", shape: SQUARE, color: "#c2568f", icon: "☂" },
];

/**
 * How many seat rows the form can offer.
 *
 * A presentation limit, not the game's: one seat needs one distinguishable identity, and there
 * are six of those. The *rule* about how many players a game takes lives in the engine, which
 * is why removing seats goes all the way down to one and the server is what says no.
 */
export const MAX_SEAT_ROWS = TOKEN_IDENTITIES.length;

// --- Draft state ------------------------------------------------------------

type BotLevel = NonNullable<SeatConfig["bot_level"]>;
type Gender = SeatConfig["grammatical_gender"];

const BOT_LEVELS: readonly BotLevel[] = ["easy", "normal", "hard"];

// No `Record<BotLevel, string>` map here: MON-501 moved the three level names to `bot_level.*`,
// so the key is the level. The same reason `ActionLabels.ts` no longer exists — a hand-written
// bridge between the engine's vocabulary and the catalogue's is a bridge that can drift.

const GENDERS: readonly Gender[] = ["n", "m", "f"];

export interface SeatDraft {
  /** Stable across reorderings, so React keys and label ids do not follow the array index. */
  readonly id: number;
  readonly name: string;
  readonly isBot: boolean;
  readonly botLevel: BotLevel;
  readonly gender: Gender;
}

/**
 * The gender a new seat starts on, which depends on the language the table is being set up in.
 *
 * **Hebrew: masculine. Everything else: neutral.** The owner asked for this on 2026-08-04, and it
 * amends what `schemas.py::SeatConfig` says — *"`n` is the neutral fallback, never the masculine"*
 * (owner decision 5, GAP G-42). That sentence is still true of the **fallback**: a seat whose gender
 * nobody chose, in a game whose language nobody chose, is still `"n"`. What changed is the *default
 * offered on a Hebrew setup screen*, where every verb in the narration conjugates and "them" is the
 * one option a Hebrew sentence cannot use gracefully. Two presses put it back, per seat, and the
 * control is right there.
 *
 * Read at the moment a row is created rather than watched: a language switch mid-setup does not
 * rewrite genders the player may already have chosen, and the fallback it leaves behind is the
 * neutral one. The app opens in Hebrew, so the two seats a family finds are masculine.
 */
export function defaultGenderFor(locale: Locale): Gender {
  return locale === "he" ? "m" : "n";
}

export function seatDraft(id: number, locale: Locale): SeatDraft {
  return { id, name: "", isBot: false, botLevel: "normal", gender: defaultGenderFor(locale) };
}
export function SeatCard({
  seat,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  readonly seat: SeatDraft;
  readonly index: number;
  readonly canRemove: boolean;
  readonly onChange: (change: Partial<SeatDraft>) => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const fieldId = useId();
  const identity = TOKEN_IDENTITIES[index % TOKEN_IDENTITIES.length];
  const seatLabel = t("setup.seat", { number: index + 1 });

  return (
    <li className="rounded-2xl bg-tile p-4 text-ink shadow-[0_2px_0_0_oklch(0%_0_0/0.10),0_10px_24px_-12px_oklch(0%_0_0/0.45)] dark:bg-[oklch(27%_0.02_255)] dark:text-[oklch(95%_0.008_95)]">
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{seatLabel}</legend>

        <div className="flex flex-wrap items-center gap-3">
          {identity !== undefined && <TokenBadge identity={identity} />}
          <div className="flex flex-col">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] opacity-60">
              {seatLabel}
            </span>
            {identity !== undefined && (
              <span className="text-sm font-medium">{t(identity.nameKey)}</span>
            )}
          </div>
          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="ms-auto min-h-11 min-w-11 rounded-xl border border-current/30 px-4 text-sm"
            >
              {t("setup.remove_player")}
              <span className="sr-only"> — {seatLabel}</span>
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${fieldId}-name`} className="text-sm font-medium">
            {t("setup.player_name")}
          </label>
          <input
            id={`${fieldId}-name`}
            type="text"
            autoComplete="off"
            value={seat.name}
            onChange={(event) => {
              onChange({ name: event.target.value });
            }}
            className="min-h-11 rounded-xl border border-current/30 bg-transparent px-3"
          />
        </div>

        <Choice
          name={`${fieldId}-kind`}
          label={t("setup.player_type")}
          options={[
            { value: "human", label: t("setup.human") },
            { value: "bot", label: t("setup.bot") },
          ]}
          value={seat.isBot ? "bot" : "human"}
          onChange={(value) => {
            onChange({ isBot: value === "bot" });
          }}
        />

        {seat.isBot && (
          <Picker
            id={`${fieldId}-level`}
            label={t("setup.bot_level_label")}
            value={seat.botLevel}
            options={BOT_LEVELS.map((level) => ({ value: level, label: t(`bot_level.${level}`) }))}
            onChange={(value) => {
              onChange({ botLevel: value as BotLevel });
            }}
          />
        )}

        <Picker
          id={`${fieldId}-gender`}
          label={t("setup.pronoun")}
          value={seat.gender}
          options={GENDERS.map((gender) => ({ value: gender, label: t(`gender.${gender}`) }))}
          onChange={(value) => {
            onChange({ gender: value as Gender });
          }}
        />
      </fieldset>
    </li>
  );
}

/**
 * A seat's identity: shape, colour, icon. Decorative — the seat's name is next to it in text.
 *
 * The SVG carries the shape so the badge survives greyscale and a colour-vision deficiency,
 * which is the whole reason the identity is not "the blue one".
 */
function TokenBadge({ identity }: { readonly identity: TokenIdentity }): React.JSX.Element {
  return (
    // `size-9` (36 px), not `size-11` (44 px). The badge is decorative and `aria-hidden`; the 44 px
    // minimum belongs to the *label* around it, which keeps `min-h-11` — so the thing a six-year-old
    // has to hit is unchanged and only the silhouette got smaller. Owner feedback on the first
    // playable build was that the pieces read as oversized, and this was the largest of them.
    <span aria-hidden="true" className="relative grid size-9 shrink-0 place-items-center">
      <svg viewBox="0 0 32 32" className="absolute inset-0 size-full">
        <path d={identity.shape} fill={identity.color} />
      </svg>
      <span className="relative text-sm">{identity.icon}</span>
    </span>
  );
}
