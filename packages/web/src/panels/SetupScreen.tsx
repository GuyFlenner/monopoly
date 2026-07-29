/**
 * Setting the table: who is playing, on which board, by which rules.
 *
 * Three decisions worth reading before changing anything here.
 *
 * 1. **Validation belongs to the engine, so the form does not do it.** There is no
 *    "at least two players" check and no duplicate-name check below. The seats are posted and
 *    the server's `{reason_key, params}` is rendered — a submit button disabled by a rule the
 *    UI worked out for itself is the same defect as a rule in the UI that happens to agree
 *    (ADR-005). The button *is* disabled while a name box is empty, which is form state: a
 *    request with an empty string in it is not a rejected game, it is an unfinished form.
 *
 * 2. **Kids mode shows what it changes, computed from `/rulesets`.** Not from
 *    `setup.kids_explainer`, which is prose that goes stale the first time a flag moves. See
 *    `SetupScreenRuleset.ts` for the diff and for the server-side seam that would delete it.
 *
 * 3. **A seat's identity is shape + colour + icon + name**, four channels, because a
 *    six-year-old picks their seat before they can read it and a colourblind adult cannot use
 *    the colour (GAP A2/G-51). Nothing here is colour-only.
 *
 * *Visual direction*: cards of warm stock laid on the felt table, each seat with a die-cut
 * badge stamped into its corner. Chunky targets, generous rounding, one accent. The badge is
 * the only flourish; the controls are deliberately plain, because a setup screen is a thing
 * people get through, not a thing they admire.
 */

import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  asApiError,
  type ApiError,
  type BoardSummary,
  type NewGameRequest,
  type Ruleset,
  type SeatConfig,
} from "@/api";
import { LOCALE_LABEL, LOCALES, type Locale } from "@/i18n";
import { Icon } from "@/theme";

import {
  diffRulesets,
  findRuleset,
  type RuleDifference,
  type RuleValue,
} from "./SetupScreenRuleset";

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
const MAX_SEAT_ROWS = TOKEN_IDENTITIES.length;

// --- Draft state ------------------------------------------------------------

type BotLevel = NonNullable<SeatConfig["bot_level"]>;
type Gender = SeatConfig["grammatical_gender"];

const BOT_LEVELS: readonly BotLevel[] = ["easy", "normal", "hard"];

// No `Record<BotLevel, string>` map here: MON-501 moved the three level names to `bot_level.*`,
// so the key is the level. The same reason `ActionLabels.ts` no longer exists — a hand-written
// bridge between the engine's vocabulary and the catalogue's is a bridge that can drift.

const GENDERS: readonly Gender[] = ["n", "m", "f"];

interface SeatDraft {
  /** Stable across reorderings, so React keys and label ids do not follow the array index. */
  readonly id: number;
  readonly name: string;
  readonly isBot: boolean;
  readonly botLevel: BotLevel;
  readonly gender: Gender;
}

function seatDraft(id: number): SeatDraft {
  // Neutral by default. `grammatical_gender` exists so Hebrew narration can agree (owner
  // decision 5); defaulting to "n" means nobody is assumed and the fallback phrasing is never
  // the masculine (GAP G-42).
  return { id, name: "", isBot: false, botLevel: "normal", gender: "n" };
}

export interface SetupScreenProps {
  /** From `GET /boards`. Rendered as offered; `name_key` is translated, never the id. */
  readonly boards: readonly BoardSummary[];
  /** From `GET /rulesets`. Both entries are needed for the Kids-mode diff to say anything. */
  readonly rulesets: readonly Ruleset[];
  readonly locale: Locale;
  readonly onLocaleChange: (locale: Locale) => void;
  /** Post the game. Rejects with an `ApiError` whose key this screen renders. */
  readonly onStart: (request: NewGameRequest) => Promise<unknown>;
}

const UNIVERSAL: Ruleset["name"] = "universal";

export function SetupScreen({
  boards,
  rulesets,
  locale,
  onLocaleChange,
  onStart,
}: SetupScreenProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const formId = useId();

  const [seats, setSeats] = useState<readonly SeatDraft[]>(() => [seatDraft(0), seatDraft(1)]);
  const [nextSeatId, setNextSeatId] = useState(2);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [rulesetName, setRulesetName] = useState<Ruleset["name"]>(UNIVERSAL);
  const [seed, setSeed] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<ApiError | null>(null);

  // The board the form will post. Falls back to the first the server offered rather than to a
  // hardcoded "classic": the list of boards is the server's to decide.
  const chosenBoardId = boardId ?? boards[0]?.id ?? null;

  const chosen = findRuleset(rulesets, rulesetName);
  const baseline = findRuleset(rulesets, UNIVERSAL);
  const differences = useMemo(
    () =>
      chosen === undefined || baseline === undefined || chosen === baseline
        ? []
        : diffRulesets(chosen, baseline),
    [chosen, baseline],
  );

  // Form state, not a rule: a seat with a blank name is an unfinished form. Everything the
  // *engine* decides — two to six players, no shared names — is decided by the engine.
  const hasBlankName = seats.some((seat) => seat.name.trim() === "");
  const canSubmit = !hasBlankName && chosenBoardId !== null && !isSubmitting;

  function updateSeat(id: number, change: Partial<SeatDraft>): void {
    setSeats((current) => current.map((seat) => (seat.id === id ? { ...seat, ...change } : seat)));
  }

  async function submit(event: React.SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (chosenBoardId === null) {
      return;
    }
    setSubmitting(true);
    setRejection(null);
    try {
      await onStart(buildRequest(seats, chosenBoardId, rulesetName, locale, seed));
    } catch (cause) {
      setRejection(asApiError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 text-start sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">{t("setup.title")}</h1>
        <p className="text-sm opacity-70">{t("app.tagline")}</p>
      </header>

      {/* --- Seats --- */}
      <fieldset className="flex flex-col gap-3">
        <legend className="pb-2 text-xs font-semibold uppercase tracking-[0.16em] opacity-70">
          {t("setup.seats")}
        </legend>
        <ol className="flex flex-col gap-3">
          {seats.map((seat, index) => (
            <SeatCard
              key={seat.id}
              seat={seat}
              index={index}
              canRemove={seats.length > 1}
              onChange={(change) => {
                updateSeat(seat.id, change);
              }}
              onRemove={() => {
                setSeats((current) => current.filter((candidate) => candidate.id !== seat.id));
              }}
            />
          ))}
        </ol>
        {seats.length < MAX_SEAT_ROWS && (
          <button
            type="button"
            onClick={() => {
              setSeats((current) => [...current, seatDraft(nextSeatId)]);
              setNextSeatId((current) => current + 1);
            }}
            className="min-h-11 self-start rounded-xl border-2 border-dashed border-current/40 px-5 text-sm font-semibold"
          >
            + {t("setup.add_player")}
          </button>
        )}
      </fieldset>

      {/* --- The table --- */}
      <fieldset className="flex flex-col gap-5 rounded-2xl bg-tile p-4 text-ink shadow-[0_2px_0_0_oklch(0%_0_0/0.10),0_10px_24px_-12px_oklch(0%_0_0/0.45)] dark:bg-[oklch(27%_0.02_255)] dark:text-[oklch(95%_0.008_95)]">
        <legend className="px-2 text-xs font-semibold uppercase tracking-[0.16em] opacity-70">
          {t("setup.table")}
        </legend>

        <Choice
          name={`${formId}-board`}
          label={t("setup.board")}
          options={boards.map((board) => ({
            value: board.id,
            label: t(board.name_key),
            hint: String(board.ownable_count),
          }))}
          value={chosenBoardId ?? ""}
          onChange={setBoardId}
        />

        <Choice
          name={`${formId}-ruleset`}
          label={t("setup.ruleset")}
          options={rulesets.map((ruleset) => ({
            value: ruleset.name,
            label: t(`setup.${ruleset.name}`),
          }))}
          value={rulesetName}
          onChange={(value) => {
            setRulesetName(value as Ruleset["name"]);
          }}
        />

        {rulesetName !== UNIVERSAL && <RuleDiff differences={differences} />}

        <Choice
          name={`${formId}-locale`}
          label={t("setup.language")}
          options={LOCALES.map((candidate) => ({
            value: candidate,
            label: LOCALE_LABEL[candidate],
          }))}
          value={locale}
          onChange={(value) => {
            onLocaleChange(value as Locale);
          }}
        />

        {/*
          The seed is behind a disclosure, closed by default.

          It is a real feature — the engine's RNG is seeded from an integer that is part of the
          serialized state (ADR-002), so the same seed deals the same dice and the same card order,
          which is what makes a game reproducible for a replay, a bug report, or an honest rematch.
          But it is a *developer's* feature wearing a player's clothes: the owner's first question on
          seeing the built form was "what is the seed option at the bottom", and a parent setting up a
          game for a six-year-old will ask the same thing and then worry they have to fill it in.

          Closed, it is one line of text nobody has to understand. Open, it is unchanged. That is
          cheaper than removing it and much cheaper than explaining it in the main flow.
        */}
        <details className="group flex flex-col gap-1">
          <summary className="target -mx-1 flex w-fit cursor-pointer items-center gap-2 rounded-lg px-1 text-sm font-medium opacity-75 hover:opacity-100">
            <Icon name="plus" size={12} className="shrink-0 group-open:hidden" />
            <Icon name="minus" size={12} className="hidden shrink-0 group-open:block" />
            {t("setup.advanced")}
          </summary>
          <div className="mt-2 flex flex-col gap-1">
            <label htmlFor={`${formId}-seed`} className="text-sm font-medium">
              {t("setup.seed")}
            </label>
            <input
              id={`${formId}-seed`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              dir="ltr"
              value={seed}
              onChange={(event) => {
                setSeed(event.target.value);
              }}
              aria-describedby={`${formId}-seed-hint`}
              className="min-h-11 max-w-56 rounded-xl border border-current/30 bg-transparent px-3 tabular-nums"
            />
            <p id={`${formId}-seed-hint`} className="text-xs opacity-70">
              {t("setup.seed_hint")}
            </p>
          </div>
        </details>
      </fieldset>

      {rejection !== null && (
        <Rejection
          error={rejection}
          heading={t("setup.cannot_start")}
          resolve={(key, params) =>
            i18n.exists(key) ? t(key, params) : t("error.illegal_move", params)
          }
        />
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="min-h-14 rounded-2xl bg-[oklch(45%_0.09_155)] px-6 text-lg font-bold text-[oklch(98%_0.01_95)] shadow-[0_3px_0_0_oklch(30%_0.07_155)] disabled:opacity-50 disabled:shadow-none"
      >
        {isSubmitting ? t("setup.starting") : t("setup.start")}
      </button>
    </form>
  );
}

// --- Pieces -----------------------------------------------------------------

function SeatCard({
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

interface Option {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * A radio group drawn as chunky cards.
 *
 * Real `<input type="radio">` elements, visually hidden and labelled — so arrow keys move
 * within the group, the label is tied to the input, and the focus ring lands on the card the
 * user can see. A `<div role="radiogroup">` with click handlers would have had to reimplement
 * all three.
 */
function Choice({
  name,
  label,
  options,
  value,
  onChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly options: readonly Option[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-current/25 px-4 py-2 text-sm font-medium has-checked:border-current has-checked:bg-current/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[oklch(70%_0.18_250)]"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => {
                onChange(option.value);
              }}
              className="sr-only"
            />
            <span>{option.label}</span>
            {option.hint !== undefined && (
              <span dir="ltr" className="tabular-nums text-xs opacity-60">
                {option.hint}
              </span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A labelled `<select>`, for the choices that are settings rather than the main decision. */
function Picker({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly Option[];
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="min-h-11 max-w-56 rounded-xl border border-current/30 bg-transparent px-3"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** What the chosen rule set changes, one row per differing flag. */
function RuleDiff({
  differences,
}: {
  readonly differences: readonly RuleDifference[];
}): React.JSX.Element {
  const { t } = useTranslation();
  if (differences.length === 0) {
    return <p className="text-sm opacity-70">{t("setup.kids_no_changes")}</p>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border-s-4 border-[oklch(72%_0.14_70)] bg-current/5 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70">
        {t("setup.kids_changes")}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {differences.map((difference) => (
          <li key={difference.field} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{t(difference.labelKey)}</span>
            <span className="font-semibold">{renderValue(difference.value, t)}</span>
            {/*
              "Full rules: N" rather than "was N → now M": an arrow is a direction, and a
              direction is the one thing that does not survive `dir="rtl"`.
            */}
            <span className="text-xs opacity-60">
              {t("ruleset.previous", { value: renderValue(difference.baseline, t) })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function renderValue(value: RuleValue, t: Translate): string {
  switch (value.kind) {
    case "flag":
      return t(value.on ? "ruleset.value.on" : "ruleset.value.off");
    case "number":
      return String(value.value);
    case "numbers":
      return value.values.join(", ");
    case "absent":
      return t("ruleset.value.none");
  }
}

/**
 * The server's refusal, rendered from its key.
 *
 * Focus moves here rather than an `aria-live` region announcing it: this package has exactly
 * one live region and it belongs to the `<Announcer>` (spec §5.5, G-54). Moving focus to the
 * message is also the standard WCAG 3.3.1 answer for a rejected form, and it says the reason
 * once rather than twice.
 */
function Rejection({
  error,
  heading,
  resolve,
}: {
  readonly error: ApiError;
  readonly heading: string;
  readonly resolve: (key: string, params: Readonly<Record<string, string | number>>) => string;
}): React.JSX.Element {
  return (
    <div
      // -1 rather than 0: the message is a focus *target*, not a tab stop. Nobody should have
      // to tab past a past failure to reach the button that retries it.
      tabIndex={-1}
      ref={(node) => {
        node?.focus();
      }}
      className="flex flex-col gap-1 rounded-xl border-s-4 border-[oklch(58%_0.19_25)] bg-[oklch(58%_0.19_25)]/10 p-3"
    >
      <strong className="text-sm">{heading}</strong>
      <p className="text-sm">{resolve(error.reasonKey, error.params)}</p>
    </div>
  );
}

/**
 * The draft, as the wire wants it.
 *
 * `bot_level` is sent explicitly as `null` for a person: the schema keeps `is_bot` on the wire
 * so that "bot with no level" is a 422 rather than a silently seated human, and omitting the
 * field would be relying on a default to say something this form knows.
 *
 * `seed` is included only when the box holds a safe integer. That is not validation of the
 * game — it is refusing to post `NaN` as a number, which would be a malformed request rather
 * than a rejected one.
 */
function buildRequest(
  seats: readonly SeatDraft[],
  boardId: string,
  ruleset: Ruleset["name"],
  locale: Locale,
  seed: string,
): NewGameRequest {
  const parsed = Number(seed.trim());
  const usable = seed.trim() !== "" && Number.isSafeInteger(parsed) && parsed >= 0;
  return {
    seats: seats.map((seat, index) => ({
      name: seat.name.trim(),
      is_bot: seat.isBot,
      bot_level: seat.isBot ? seat.botLevel : null,
      token: TOKEN_IDENTITIES[index % TOKEN_IDENTITIES.length]?.token ?? String(index),
      grammatical_gender: seat.gender,
    })),
    board_id: boardId,
    ruleset,
    locale,
    ...(usable ? { seed: parsed } : {}),
  };
}
