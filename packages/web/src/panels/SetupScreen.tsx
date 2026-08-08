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
 * 2. **Kids mode shows what it changes, and the server is what says what changed.** Not
 *    `setup.kids_explainer`, which is prose that goes stale the first time a flag moves — and, as
 *    of MON-417, not a client-side diff either. `/rulesets` returns a `RulesetView` whose every
 *    flag carries a `label_key` and a `differs_from_universal`, so this file filters and renders.
 *    `SetupScreenRuleset.ts` — a `Record<keyof Ruleset, …>` label map plus a `diffRulesets` over
 *    the raw flags — is deleted: a client that works out which rules are in force is one rename
 *    away from explaining the wrong ones, and G-36 is what closed the seam it documented.
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
  type AuctionMinimum,
  type BoardSummary,
  type NewGameRequest,
  type RulesetView,
} from "@/api";
import { SCREEN_HEADING_ATTRIBUTE } from "@/a11y";
import {
  clampCardSeconds,
  MAX_CARD_SECONDS,
  MIN_CARD_SECONDS,
  useCardDwellPreference,
} from "@/animation";
import { LOCALE_LABEL, LOCALES, type Locale } from "@/i18n";
import type { Transport } from "@/local/mode";
import { Icon, tokenForSeat } from "@/theme";

import { LoadSavedGame } from "./LoadSavedGame";
import { RuleDiff } from "./RuleDiff";
import { MAX_SEAT_ROWS, SeatCard, seatDraft, type SeatDraft } from "./SeatCard";
import { Choice } from "./SetupFields";
import { ErrorState } from "./States";

export interface SetupScreenProps {
  /**
   * From `GET /boards`, already filtered to the boards that can be named (MON-419).
   *
   * The filter is the shell's, in `App.tsx`, because it also owns the "no boards at all" state —
   * see there. Rendered as offered; `name_key` is translated, never the id.
   */
  readonly boards: readonly BoardSummary[];
  /**
   * From `GET /rulesets`. Each flag arrives with its label key and whether it differs from the
   * universal rules, so this screen filters and renders and computes nothing (MON-417).
   */
  readonly rulesets: readonly RulesetView[];
  readonly locale: Locale;
  readonly onLocaleChange: (locale: Locale) => void;
  /** Post the game. Rejects with an `ApiError` whose key this screen renders. */
  readonly onStart: (request: NewGameRequest) => Promise<unknown>;
  /**
   * Restore a saved game instead of starting a new one (MON-704).
   *
   * Optional so that a test of the seating form need not supply one, and so the affordance is absent
   * rather than broken in a context that cannot load — `App` passes it, and `App` is what owns the
   * client. Rejects with an `ApiError` whose key `<LoadSavedGame>` renders.
   */
  readonly onLoad?: (save: unknown) => Promise<unknown>;
  /**
   * Where the game will live — the engine in this tab, or the server (MON-728).
   *
   * Rendered as a first question rather than buried with the house rules, because it is not a rule:
   * it decides who can reach the game at all, and it has to be answered before names are typed since
   * changing it re-asks the *other* engine for the boards and rule sets.
   */
  readonly transport?: Transport;
  /**
   * Take the answer, and by its presence say whether to ask at all.
   *
   * Omitted where there is no choice to offer — a dev build is already online, and a published build
   * with no API URL has no server to reach. Absent rather than disabled, the same reasoning
   * {@link SetupScreenProps.onLoad} uses: a control that cannot work should not be on the screen
   * explaining why.
   */
  readonly onTransportChange?: ((transport: Transport) => void) | undefined;
}

const UNIVERSAL: RulesetView["name"] = "universal";

/**
 * Both floors, in the order they are offered.
 *
 * A literal list rather than a derivation, because there is nothing to derive from: the enum lives
 * in the generated types as a union of string literals, so `satisfies` is what checks this against
 * the contract — add a third floor to the engine and this line stops compiling.
 */
const AUCTION_MINIMUMS = ["list_price", "none"] as const satisfies readonly AuctionMinimum[];

/** Find a rule set by name in whatever order `/rulesets` returned them. */
function findRuleset(
  rulesets: readonly RulesetView[],
  name: RulesetView["name"],
): RulesetView | undefined {
  return rulesets.find((ruleset) => ruleset.name === name);
}

export function SetupScreen({
  boards,
  rulesets,
  locale,
  onLocaleChange,
  onStart,
  onLoad,
  transport = "same-screen",
  onTransportChange,
}: SetupScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  const formId = useId();

  const [seats, setSeats] = useState<readonly SeatDraft[]>(() => [
    seatDraft(0, locale),
    seatDraft(1, locale),
  ]);
  const [nextSeatId, setNextSeatId] = useState(2);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [rulesetName, setRulesetName] = useState<RulesetView["name"]>(UNIVERSAL);
  /*
    The house rules this table is starting with (MON-712), and the one place the product's own
    default lives.

    **Auctions start off**, which is not what the printed rules say and is deliberate. The owner
    reported the reason: playing with his child, every square he declined went to a ₪1 bid, again
    and again, because the no-reserve rule assumes bidders who compete and across a generation gap
    there is nobody to hold the price up. The engine keeps the printed rule — `Ruleset.universal()`
    is what the golden games are recorded against, so a default that diverged there would make every
    one of them a record of a variant — and the divergence is stated here, on the screen that
    decides what game to start, where a player can see it and change it in one press.

    The floor defaults to the deed's own price *for the table that turns auctions back on*, because
    an increment rule cannot help: the exploit is the first bid, not the raise after it.
  */
  const [auctionsEnabled, setAuctionsEnabled] = useState(false);
  const [auctionMinimum, setAuctionMinimum] = useState<AuctionMinimum>("list_price");
  const [seed, setSeed] = useState("");
  /*
    A stored preference rather than form state (MON-719): it is in effect the moment it changes, for
    the game in progress as well as the next one, and it is deliberately not part of what `onStart`
    posts. See `animation/cardDwell.ts`.
  */
  const { seconds: cardSeconds, setSeconds: setCardSeconds } = useCardDwellPreference();
  const [isSubmitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<ApiError | null>(null);

  // The board the form will post. Falls back to the first the server offered rather than to a
  // hardcoded id: the list of boards is the server's to decide, and so is which one leads it — see
  // `board/loader.py::PREFERRED_BOARDS`, where "first" is documented as meaning "the default"
  // (MON-716, the Israeli board).
  const chosenBoardId = boardId ?? boards[0]?.id ?? null;

  // A filter over what the server marked, not a diff. `differs_from_universal` is
  // `Ruleset.differing_settings`'s answer, and the order is the contract's field order — so the
  // list reads the same way twice running without this file sorting anything (MON-417).
  const chosen = findRuleset(rulesets, rulesetName);
  const differences = useMemo(
    () => (chosen === undefined ? [] : chosen.flags.filter((flag) => flag.differs_from_universal)),
    [chosen],
  );

  // Form state, not a rule: a seat with a blank name is an unfinished form. Everything the
  // *engine* decides — two to six players, no shared names — is decided by the engine.
  const hasBlankName = seats.some((seat) => seat.name.trim() === "");
  /*
    Whether the form *can* be posted, and deliberately not "and it is not already posting" (MON-703).

    `isSubmitting` used to be part of this, and it made the start button drop the keyboard: pressing it
    disabled it, a disabled element cannot hold focus, and the browser's answer to that is `<body>` —
    from where Tab starts again at the top of the page. `e2e/keyboard.spec.ts` found it on the one
    press every player makes. Re-entry is guarded inside `submit` instead, which is where "already in
    flight" is actually known and where guarding it costs nobody their place on the page. The button's
    *label* still changes, so a player can see the difference.

    The remaining condition is validation — a seat with no name, or no board — which no press of this
    button can cause, so it can never take focus away from a player who is on it.
  */
  const canSubmit = !hasBlankName && chosenBoardId !== null;

  function updateSeat(id: number, change: Partial<SeatDraft>): void {
    setSeats((current) => current.map((seat) => (seat.id === id ? { ...seat, ...change } : seat)));
  }

  async function submit(event: React.SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (chosenBoardId === null || isSubmitting) {
      return;
    }
    setSubmitting(true);
    setRejection(null);
    try {
      await onStart(
        buildRequest(seats, chosenBoardId, rulesetName, locale, seed, {
          auctions_enabled: auctionsEnabled,
          ...(auctionsEnabled ? { auction_minimum: auctionMinimum } : {}),
        }),
      );
    } catch (cause) {
      setRejection(asApiError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    /*
      The `<main>` is MON-703's finding and it was the largest single one: this screen had **no
      landmark at all**. An unnamed `<form>` is not a landmark, so every fieldset, legend and section
      on the first screen a player meets sat outside the landmark structure — axe's `region` rule,
      sixteen nodes of it. `App.tsx`'s `<Frame>` already wrapped this screen's *loading, empty and
      error* states in a `<main>`, which is how the gap survived: the three states nobody looks at
      were structured and the screen everybody starts on was not.

      Wrapping rather than making the `<form>` itself the landmark, because the two elements answer
      different questions — `<main>` is "where the content of this page is" and `<form>` is "these
      controls submit together" — and a `<main>` that is also a form cannot gain a second form later.
    */
    <main className="mx-auto flex w-full max-w-3xl flex-col p-4 text-start sm:p-6">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex w-full flex-col gap-6"
      >
        <header className="flex flex-col gap-1">
          {/* `tabIndex={-1}` and the marker so leaving a game lands focus here rather than on
              `<body>` — see `a11y/screenFocus.ts`. Never a tab stop. */}
          <h1
            {...{ [SCREEN_HEADING_ATTRIBUTE]: "" }}
            tabIndex={-1}
            className="text-3xl font-bold tracking-tight"
          >
            {t("setup.title")}
          </h1>
          <p className="text-ink-muted text-sm">{t("app.tagline")}</p>
        </header>

        {/*
          --- Where the game lives (MON-728) ---

          First, and above the seats, because it is the question the others depend on: it decides
          which engine answers, so changing it re-asks for the boards and the rule sets. A player who
          answered it after typing six names would watch the form's lists reload underneath them.

          Absent entirely where there is no choice — see `onTransportChange`.
        */}
        {onTransportChange !== undefined && (
          <div className="flex flex-col gap-2">
            <Choice
              name={`${formId}-where`}
              label={t("setup.where")}
              options={[
                { value: "same-screen", label: t("setup.where_here") },
                { value: "online", label: t("setup.where_elsewhere") },
              ]}
              value={transport}
              onChange={(value) => {
                onTransportChange(value as Transport);
              }}
            />
            {/*
              The consequence, stated only for the answer that has one. "Same screen" is what the
              game has always done and needs no note; "elsewhere" costs a wait on a sleeping free-tier
              service and produces a link the player then has to send, and both are surprises worth
              having in advance rather than discovering.
            */}
            <p data-testid="setup-where-note" className="text-ink-muted text-xs">
              {transport === "online"
                ? t("setup.where_elsewhere_note")
                : t("setup.where_here_note")}
            </p>
          </div>
        )}

        {/* --- Seats --- */}
        <fieldset className="flex flex-col gap-3">
          <legend className="text-ink-muted pb-2 text-xs font-semibold uppercase tracking-[0.16em]">
            {t("setup.seats")}
          </legend>
          {/* `data-testid` so the e2e helper can find a seat row without reading a translated label:
              MON-707's smoke fills this form in Hebrew as well as in English. */}
          <ol data-testid="setup-seats" className="flex flex-col gap-3">
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
                setSeats((current) => [...current, seatDraft(nextSeatId, locale)]);
                setNextSeatId((current) => current + 1);
              }}
              className="min-h-11 self-start rounded-xl border-2 border-dashed border-edge px-5 text-sm font-semibold"
            >
              + {t("setup.add_player")}
            </button>
          )}
        </fieldset>

        {/* --- The table --- */}
        <fieldset className="flex flex-col gap-5 rounded-2xl bg-panel p-4 text-on-panel shadow-card">
          <legend className="text-ink-muted px-2 text-xs font-semibold uppercase tracking-[0.16em]">
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
            // `label_key` off the wire, rather than `` t(`setup.${ruleset.name}`) `` — the same
            // reasoning as the flags: the server names the choice, the client renders the name.
            options={rulesets.map((ruleset) => ({
              value: ruleset.name,
              label: t(ruleset.label_key),
            }))}
            value={rulesetName}
            onChange={(value) => {
              setRulesetName(value as RulesetView["name"]);
            }}
          />

          {rulesetName !== UNIVERSAL && <RuleDiff differences={differences} />}

          {/*
            The house rules, in the flow rather than behind the advanced disclosure.

            The seed hides because it is a developer's feature wearing a player's clothes. This is
            the opposite: it is the setting a parent most wants and the one they cannot discover any
            other way, since with auctions off there is no auction on screen to notice the absence
            of.

            Its own fieldset and its own wording, because otherwise "Auctions" appears twice on this
            screen meaning two different things. `<RuleDiff>` above answers *what Kids Mode changes
            about the rules*; this answers *what this table is doing tonight*, and it is the one that
            wins — a kids game with the switch on has auctions, whatever the diff says Kids Mode does
            by itself. Two controls sharing `ruleset.auctions_enabled` as a name is a defect for a
            screen reader before it is one for a test.
          */}
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 text-sm font-medium">{t("setup.house_rules")}</legend>
            <p className="text-ink-muted text-xs">{t("setup.house_rules_note")}</p>

            <Choice
              name={`${formId}-auctions`}
              label={t("setup.auctions_here")}
              options={[
                { value: "off", label: t("ruleset.value.off") },
                { value: "on", label: t("ruleset.value.on") },
              ]}
              value={auctionsEnabled ? "on" : "off"}
              onChange={(value) => {
                setAuctionsEnabled(value === "on");
              }}
            />

            {/*
              Only when there is an auction to have a floor for. A disabled control would be a second
              way of saying what the switch above already says, and an always-visible one would ask a
              parent to answer a question about a feature they have just turned off.
            */}
            {auctionsEnabled && (
              <Choice
                name={`${formId}-auction-minimum`}
                label={t("ruleset.auction_minimum")}
                options={AUCTION_MINIMUMS.map((candidate) => ({
                  value: candidate,
                  label: t(`auction_minimum.${candidate}`),
                }))}
                value={auctionMinimum}
                onChange={(value) => {
                  setAuctionMinimum(value as AuctionMinimum);
                }}
              />
            )}
          </fieldset>

          {/*
            How long a card stays up, in seconds (MON-719).

            In the flow rather than behind the advanced disclosure, and beside the house rules rather
            than with the seed, on the same reasoning the house rules give: the seed hides because it
            is a developer's feature wearing a player's clothes, and this is the opposite — the owner
            asked for it because a card left the screen before he had read it, and a setting that
            answers that has to be findable by the person who noticed.

            It is **not** on the create-game request. How long a card is *shown* belongs to whoever is
            looking at the screen, not to the game being played, so it is a `localStorage` preference
            like the mute and the motion switches (`animation/cardDwell.ts`) — which also means it is
            already in effect for the game in progress, and applies to the next game without being
            asked again. Nothing waits for it either way: a card can be put down at any moment.
          */}
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-card-seconds`} className="text-sm font-medium">
              {t("setup.card_seconds")}
            </label>
            <input
              id={`${formId}-card-seconds`}
              type="number"
              inputMode="numeric"
              min={MIN_CARD_SECONDS}
              max={MAX_CARD_SECONDS}
              step={1}
              dir="ltr"
              value={cardSeconds}
              onChange={(event) => {
                // Only a value the store would keep. An out-of-range or half-typed entry leaves the
                // stored choice alone rather than being silently rounded into something else, so the
                // field cannot end a session holding a number the game is not using.
                const chosen = clampCardSeconds(event.target.value);
                if (chosen !== null) {
                  setCardSeconds(chosen);
                }
              }}
              aria-describedby={`${formId}-card-seconds-hint`}
              className="min-h-11 max-w-56 rounded-xl border border-edge bg-transparent px-3 tabular-nums"
            />
            <p id={`${formId}-card-seconds-hint`} className="text-ink-muted text-xs">
              {t("setup.card_seconds_hint", {
                min: MIN_CARD_SECONDS,
                max: MAX_CARD_SECONDS,
              })}
            </p>
          </div>

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
            <summary className="target text-ink-muted hover:text-on-panel -mx-1 flex w-fit cursor-pointer items-center gap-2 rounded-lg px-1 text-sm font-medium">
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
                className="min-h-11 max-w-56 rounded-xl border border-edge bg-transparent px-3 tabular-nums"
              />
              <p id={`${formId}-seed-hint`} className="text-ink-muted text-xs">
                {t("setup.seed_hint")}
              </p>
            </div>
          </details>
        </fieldset>

        {rejection !== null && <ErrorState error={rejection} headingKey="setup.cannot_start" />}

        {/*
          The one button the theme paints itself, and until MON-746 the one colour nothing could
          measure: `bg-[oklch(45%_0.09_155)]` on the first screen anybody sees. Same green, named —
          and now rimmed with the keyline like every other painted area here, because the fill alone
          reaches 2.65:1 against a dark page and an edge is not something a button may be missing.
        */}
        <button
          type="submit"
          disabled={!canSubmit}
          className="border-hairline bg-cta text-on-cta shadow-cta min-h-14 rounded-2xl border px-6 text-lg font-bold disabled:opacity-50 disabled:shadow-none"
        >
          {isSubmitting ? t("setup.starting") : t("setup.start")}
        </button>

        {/*
          Last on the page, and inside the form only for layout: the input is `type="file"`, so it
          submits nothing and cannot be reached by Enter in a text box. Below the start button because
          setting up a new game is what most people are here for and a save is the exception — but on
          the same screen, because "where is my game from yesterday" must not require finding a menu.
        */}
        {onLoad !== undefined && <LoadSavedGame onLoad={onLoad} />}
      </form>
    </main>
  );
}

// --- What the form posts ----------------------------------------------------

/*
 * The pieces that used to be under this line are siblings as of MON-747: `SeatCard.tsx` (the seat
 * row and the model behind it), `SetupFields.tsx` (the radio group and the select they share) and
 * `RuleDiff.tsx` (what the chosen rule set changes). The move was a move — same bodies, same
 * docstrings, and an `export` in front of each name this file still calls. It was taken a second
 * time, against the merged file, so that MON-748's shared identities and MON-743/746's measured
 * tokens are what travelled rather than the bytes they replaced.
 */

/*
 * `Rejection` used to live here — a focus-target box that rendered `{reason_key, params}`, with a
 * `resolve` prop threading an `i18n.exists` guard in from the caller. MON-708 replaced it with
 * `<ErrorState>`, which is the same box with the guard built in: the fourth copy of "render a
 * failure" was the one that would have got it wrong, and the guard is not optional — under dev and
 * test an unguarded `t()` on a key a newer server invented *throws*, replacing the rejection with a
 * blank screen. No behaviour changed, including the focus move and the WCAG 3.3.1 reasoning behind
 * it; see `States.tsx`.
 */

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
  ruleset: RulesetView["name"],
  locale: Locale,
  seed: string,
  /**
   * What this table changed about the named rule set (MON-712).
   *
   * Sent whole rather than only when it differs from the printed rules, and that is the honest
   * shape: the screen has *decided* that auctions are off unless told otherwise, so saying nothing
   * would leave the server to apply a default the player never chose. The floor is omitted when
   * auctions are off, because a floor for an auction that cannot happen is not a fact about the
   * game — and `HouseRules` reads an absent field as "leave the rule set alone".
   */
  houseRules: NonNullable<NewGameRequest["house_rules"]>,
): NewGameRequest {
  const parsed = Number(seed.trim());
  const usable = seed.trim() !== "" && Number.isSafeInteger(parsed) && parsed >= 0;
  return {
    seats: seats.map((seat, index) => ({
      name: seat.name.trim(),
      is_bot: seat.isBot,
      bot_level: seat.isBot ? seat.botLevel : null,
      // The seat's own icon name, read from the same `TOKEN_IDENTITY` the badge above draws —
      // not a second literal that could name a different piece than the one shown.
      token: `token.${tokenForSeat(index + 1).icon}`,
      grammatical_gender: seat.gender,
    })),
    board_id: boardId,
    ruleset,
    house_rules: houseRules,
    locale,
    ...(usable ? { seed: parsed } : {}),
  };
}
