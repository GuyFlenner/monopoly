/**
 * The card, held up on the board (MON-709).
 *
 * Before this, landing on Chance or Community Chest produced a log line naming the *deck* and nothing
 * else: the sentence the player was being asked to obey — "move ahead to Illinois Avenue", "pay $25
 * for each house you own" — appeared nowhere on screen. This is that sentence, on a card-shaped
 * surface, for as long as the animation queue holds the beat.
 *
 * ## It decides nothing and gates nothing
 *
 * Every field comes off `RevealedCard`, which `timeline.ts` copied off the event stream. `cardId` is
 * the engine's own catalogue key, so the card's text is a lookup; `delta` and `balance` are the
 * figures a `cash_changed` stated, so the amount is a lookup too. There is no arithmetic in this file
 * and no branch on what any card *does* — "collect" versus "pay" is chosen by the sign of a number the
 * server sent, which is grammar rather than a rule.
 *
 * And nothing waits for it. This is a sibling of the board, drawn over it on a layer that is
 * `pointer-events-none` except for the card itself, so the squares underneath stay clickable and the
 * action bar in the column beside it never learns a card exists. A player can roll, buy, trade or end
 * their turn straight through the reveal — see `GameScreen.tsx`, where there is nowhere for a wait to
 * be added.
 *
 * ## Two decks, told apart three ways
 *
 * Colour is the *least* of them, per this project's standing rule (spec §5.4): the deck is named in
 * words, drawn as a glyph whose outline survives greyscale (`spark` against `chest`), and edged in a
 * distinct border style (dashed against double). Any one of the three is enough on its own.
 *
 * ## The card body may be English inside a Hebrew game, and says so
 *
 * `cards.he.json` landed with MON-506, so a Hebrew game now shows a Hebrew card — and this component
 * did not change to make that happen, which was the point of building it this way. The body carries
 * `lang`/`dir` describing the language its text actually *turned out* to be in, which switches a
 * screen reader's voice and keeps the bidi layout correct. Today that is usually nothing to declare;
 * it still speaks up for a card the Hebrew deck has not got, where i18next falls back to English and
 * the body is genuinely English inside an RTL page. See {@link cardBodyLanguage}.
 *
 * ## Focus never falls to the body
 *
 * A control that vanishes takes the keyboard focus with it, and this one vanishes by design — on
 * dismiss, on skip, and on its own timeout. So the surface remembers whether the focus was inside it
 * and hands it to `returnFocusRef` on the way out. This defect has bitten this repo twice; it is
 * handled here for all three exits rather than for the one that is easy to see.
 */

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RevealedCard } from "@/animation";
import { useMotionPreference } from "@/board/motion";
import { useCopy } from "@/i18n/copy";
import { Icon } from "@/theme";

import { cardBodyLanguage, DECK_ICON, figureKey } from "./cardSurface";
import { DECK_KEYS } from "./EventLogLines";

import "@/animation/animation.css";

/**
 * How long the card takes to arrive, in milliseconds.
 *
 * Short and deliberately unrelated to `DEFAULT_DURATIONS.cardMs`: the queue owns how long the card
 * *stays*, and this is only how long it takes to get there. A dwell-length fade would be a card that
 * is still arriving when it is due to leave.
 */
export const CARD_IN_MS = 280;

/** Edge treatment per deck. A second non-colour channel, and the one that reads at a glance. */
const DECK_EDGE: Readonly<Record<RevealedCard["deck"], string>> = {
  chance: "border-4 border-dashed",
  community_chest: "border-4 border-double",
};

export interface CardRevealProps {
  readonly card: RevealedCard;
  /** The drawing seat's name, out of `state.players`. A lookup, handed in. */
  readonly playerName: string;
  /** `presentationFor(state.ruleset).kids` — larger type and the simpler wording (MON-604). */
  readonly kids: boolean;
  /** Put the card down. `GameScreen` wires this to the queue's own `skip`. */
  readonly onDismiss: () => void;
  /**
   * Where the keyboard focus goes when this unmounts with the focus inside it.
   *
   * `GameScreen` points it at `<SkipMotionButton>`: a control that is always mounted, sits directly
   * under the board, and is about the same thing this card's dismiss button is about — "I have seen
   * enough of this, catch up".
   */
  readonly returnFocusRef?: React.RefObject<HTMLElement | null> | undefined;
}

export function CardReveal({
  card,
  playerName,
  kids,
  onDismiss,
  returnFocusRef,
}: CardRevealProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const copy = useCopy(kids);
  const { durationMs } = useMotionPreference();

  /**
   * Whether the focus is inside this card right now.
   *
   * Tracked from `focusin`/`focusout` rather than read off `document.activeElement` in the cleanup,
   * because by the time a passive effect's cleanup runs the node may already be detached — at which
   * point `activeElement` is the body and the question can no longer be asked.
   */
  const holdsFocus = useRef(false);

  useEffect(
    () => () => {
      if (holdsFocus.current) {
        returnFocusRef?.current?.focus();
      }
    },
    [returnFocusRef],
  );

  const dismiss = useCallback(() => {
    // Focus first, then unmount. The other order asks the browser to focus an element while the
    // element that had the focus is being removed, which is how a focus ring ends up nowhere.
    returnFocusRef?.current?.focus();
    holdsFocus.current = false;
    onDismiss();
  }, [onDismiss, returnFocusRef]);

  const deckName = t(DECK_KEYS[card.deck]);

  /*
    The card's own sentence, from the `cards` namespace.

    Guarded with `i18n.exists` for the same reason the log guards a `rent.note.*` key: `card_id`
    arrives from the *engine*, `missingKeyHandler` throws under dev and test by design (G-F17), and a
    deck that has grown a card the catalogue has not must not take the board down. The fallback names
    the gap rather than printing a raw key at a child.
  */
  const textKey = `cards:${card.cardId}`;
  const text = i18n.exists(textKey) ? t(textKey) : copy("card_reveal.unnamed");
  const bodyLanguage = cardBodyLanguage(text, i18n.language);

  const amountKey = figureKey(card.delta);

  return (
    <div
      data-testid="card-reveal-layer"
      /*
        `pointer-events-none` is the non-blocking guarantee made physical: the layer covers the board
        so the card can be centred over it, and every click passes straight through to the square
        underneath except the ones that land on the card. `inset-0` is symmetric, so there is no start
        or end in it to get backwards.
      */
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-3"
    >
      <div
        // The beat as the key: drawing the same card twice in a row remounts this and replays the
        // entrance, rather than leaving a card that is already on screen sitting still. `DiceTray`'s
        // `Die` idiom, and `Beat.tsx`'s.
        key={card.nonce}
        data-testid="card-reveal"
        data-deck={card.deck}
        data-beat={card.nonce}
        // `group` rather than a named `<section>`: a landmark that appears and disappears twice a
        // minute is a landmark a screen-reader user learns to ignore. The narration is the
        // `<Announcer>`'s, and there is deliberately no `aria-live` here (GAP G-D1/G-54).
        role="group"
        aria-label={copy("card_reveal.label", { deck: deckName, name: playerName })}
        onFocus={() => {
          holdsFocus.current = true;
        }}
        onBlur={() => {
          holdsFocus.current = false;
        }}
        className={`kesef-card-in bg-tile text-ink pointer-events-auto flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4 text-start shadow-2xl ${DECK_EDGE[card.deck]}`}
        style={
          { "--kesef-motion-ms": `${String(durationMs(CARD_IN_MS))}ms` } as React.CSSProperties
        }
      >
        <p className="flex items-center gap-2">
          {/* `aria-hidden` by construction (`Icon`): the deck is named in the words beside it. */}
          <Icon name={DECK_ICON[card.deck]} size={kids ? 32 : 24} />
          <span
            data-testid="card-reveal-deck"
            className="text-xs font-semibold tracking-[0.16em] uppercase opacity-80"
          >
            {deckName}
          </span>
          {/* Whose card it is. With six seats and bots taking turns, "who drew this" is half the
              sentence — and the seat's name is the projection's, never this file's. */}
          <span className="ms-auto text-xs font-bold">{playerName}</span>
        </p>

        {/*
          The card itself. `lang`/`dir` describe the language the text *is* in, which is not always
          the page's — see the module docstring and `cardSurface.ts`.
        */}
        <p
          data-testid="card-reveal-text"
          lang={bodyLanguage?.lang}
          dir={bodyLanguage?.dir}
          className={kids ? "text-lg leading-snug font-semibold" : "text-base leading-snug"}
        >
          {text}
        </p>

        {/*
          The outcome, when the events after the draw stated one. Both figures are interpolated into
          catalogue sentences rather than printed bare, which is what puts them through the shared
          formatter — and therefore through bidi isolation, so a Latin numeral inside a Hebrew sentence
          does not reorder the words around it (GAP G-43).
        */}
        {amountKey !== null && card.delta !== null && (
          <p
            data-testid="card-reveal-figure"
            className={kids ? "text-xl font-bold" : "text-lg font-bold"}
          >
            {copy(amountKey, { amount: Math.abs(card.delta) })}
          </p>
        )}
        {card.balance !== null && (
          <p data-testid="card-reveal-balance" className="text-xs opacity-75">
            {copy("card_reveal.balance", { balance: card.balance })}
          </p>
        )}

        <button
          type="button"
          data-testid="card-reveal-dismiss"
          onClick={dismiss}
          onKeyDown={(event) => {
            /*
              Escape, on the control rather than on the card around it or on the document.

              On the button because that is the only focusable thing the card contains, so it is
              where a keyboard reader's focus actually is — and because a `role="group"` with a key
              handler is a non-interactive element pretending to be interactive, which is both a lint
              error and the thing the lint is right about. Not on the document either: a global
              listener would be a second opinion about Escape in a screen whose modals already have
              one.
            */
            if (event.key === "Escape") {
              event.stopPropagation();
              dismiss();
            }
          }}
          className="target bg-table text-on-table border-hairline self-start rounded-xl border px-4 py-2 text-sm font-semibold"
        >
          {copy("card_reveal.dismiss")}
        </button>
      </div>
    </div>
  );
}
