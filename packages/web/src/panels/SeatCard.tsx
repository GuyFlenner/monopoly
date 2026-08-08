/**
 * One seat, as the setup screen lets a family edit it.
 *
 * Moved out of `SetupScreen.tsx` in MON-747, where it was the largest of the pieces below a
 * thousand-line form. The seat's *model* came with it — what a draft seat is, how many rows there
 * can be, and which gender a new row starts on — because those exist to describe this row and
 * nothing else in the package reads them. The screen imports them back.
 *
 * Nothing here changed in the move except the `export` keywords and the import of `Choice` and
 * `Picker`, which are now the sibling this file and the screen share. In particular the identities
 * are still MON-748's — `tokenForSeat`, the one table the board, the dossier and the auction list
 * also read — and the surfaces are still MON-743/746's measured tokens.
 */

import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { SeatConfig } from "@/api";
import { Token, TOKEN_PX } from "@/board";
import type { Locale } from "@/i18n";
import { SEAT_COUNT, tokenForSeat, type SeatNumber } from "@/theme";

import { Choice, Picker } from "./SetupFields";

// --- Seat identities --------------------------------------------------------

/**
 * MON-748 (closing MON-412's TODO): the seat picker draws the six shipped token identities —
 * shape, colour and icon from `TOKEN_IDENTITY` in `@/theme/tokens`, the same table the board, the
 * turn indicator, the dossier and the auction list read for the same seat. There used to be a
 * second, local set of six here (kite, drum, boat, …) built in parallel while MON-412 was still
 * in flight; it is gone, and so is the drift risk of two silhouette sets that both claim to be
 * "the" identities. Nothing below picks a shape or a colour of its own — every seat's badge and
 * name is `tokenForSeat(seatNumber)`, imported.
 *
 * The `token` posted as `SeatConfig.token` is derived from the identity's icon name
 * (`token.${icon}`, e.g. `"token.cat"`) rather than invented separately: the engine only asks
 * that it be a non-empty string unique per seat (`state.py`'s duplicate check, MON-735), so this
 * keeps one source for "which piece is seat N" instead of two that could disagree.
 */

/**
 * How many seat rows the form can offer.
 *
 * A presentation limit, not the game's: one seat needs one distinguishable identity, and there
 * are six of those. The *rule* about how many players a game takes lives in the engine, which
 * is why removing seats goes all the way down to one and the server is what says no.
 */
export const MAX_SEAT_ROWS = SEAT_COUNT;

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
  // Bounds-checked the same way `board/projection.ts::seatOf` is, rather than an unchecked cast:
  // `index` is always `< SEAT_COUNT` in practice (seats.length is capped at `MAX_SEAT_ROWS` —
  // see the "add seat" button below), but nothing here relies on that by assertion alone.
  const seatNumber = index < SEAT_COUNT ? ((index + 1) as SeatNumber) : undefined;
  const identity = seatNumber === undefined ? undefined : tokenForSeat(seatNumber);
  const seatLabel = t("setup.seat", { number: index + 1 });

  return (
    <li className="rounded-2xl bg-panel p-4 text-on-panel shadow-card">
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{seatLabel}</legend>

        <div className="flex flex-wrap items-center gap-3">
          {seatNumber !== undefined && <Token seat={seatNumber} size={TOKEN_PX.inline} />}
          <div className="flex flex-col">
            <span className="text-ink-muted text-xs font-semibold uppercase tracking-[0.14em]">
              {seatLabel}
            </span>
            {identity !== undefined && (
              <span className="text-sm font-medium">{t(`token.${identity.icon}`)}</span>
            )}
          </div>
          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="ms-auto min-h-11 min-w-11 rounded-xl border border-edge px-4 text-sm"
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
            className="min-h-11 rounded-xl border border-edge bg-transparent px-3"
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
