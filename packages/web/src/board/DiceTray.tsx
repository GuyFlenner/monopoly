/**
 * Two dice, the roll they actually produced, and a flourish nobody has to wait for.
 *
 * ## The animation is decoration and can be proved to be
 *
 * The faces, the total and the doubles flag are rendered from `DiceView` unconditionally, before any
 * motion preference is consulted. The tumble is a CSS animation on the *same* elements, so there is
 * no state in which the DOM shows something other than the authoritative post-command result — not
 * "briefly", not "until the animation ends". Nothing is gated on `animationend`, nothing is hidden
 * while spinning, and a player can act mid-flourish because there is nothing to act *through*
 * (GAP G-F2). A test asserts the pips are identical with animation on and off.
 *
 * ## Total and doubles are read, not worked out
 *
 * `DiceView` ships `total` and `is_doubles` precisely so that no client adds two numbers or compares
 * them (G-36, ADR-008). `first + second` and `first === second` do not appear in this file, and a
 * test deletes any temptation to add them by asserting that a projection which disagrees with
 * arithmetic is rendered as the projection said.
 *
 * ## The skip switch is persistent, focusable and announced
 *
 * "Skippable" was a word with no mechanism (GAP G-F1). It is now a real toggle: `aria-pressed`, a
 * 44 px target, reachable by keyboard at any time rather than only while something is moving, and
 * remembered in `localStorage`. Turning it on or off is announced through MON-411's `<Announcer>`.
 *
 * ## No live region here
 *
 * The roll itself is *not* announced from this component. `useEventNarration` already narrates
 * `dice_rolled` off the event stream, and a second announcement of the same roll — from a second
 * region or through a second push — is the double-speak defect (GAP G-D1/G-54). What this component
 * announces is the one thing only it knows: that the player just changed the animation setting.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAnnounce } from "@/a11y";
import type { DiceView } from "@/api";

import { useMotionPreference } from "./motion";

import "./board.css";

/** How long a full tumble lasts. Short: a die that spins for a second is a die in the way. */
export const TUMBLE_MS = 420;

/**
 * Which of the nine slots in a 3 x 3 grid a face's pips occupy.
 *
 * The layouts a real die uses. Only faces one to six exist, so an out-of-range value from the wire
 * draws no pips at all and shows its numeral instead — visible nonsense rather than a plausible face.
 */
const PIP_SLOTS: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

interface DieProps {
  readonly value: number;
  /** Bumped on each new roll; remounts the face so the CSS animation replays. */
  readonly nonce: number;
  readonly durationMs: number;
  /** Milliseconds of delay, so two dice do not tumble in lockstep. */
  readonly delayMs: number;
}

/**
 * One die.
 *
 * A chunky rounded square with a keyline and drilled pips, because that is what a die feels like.
 * `dir="ltr"` on the face is the treatment spec 5.3 asks for by name — "numbers, money and dice get
 * explicit `dir="ltr"` inside an RTL page" — and is not a new exception: the pip layout is a picture
 * of an object, and objects do not mirror when a sentence does.
 */
function Die({ value, nonce, durationMs, delayMs }: DieProps): React.JSX.Element {
  const slots = PIP_SLOTS[value];
  return (
    <span
      // The nonce is the key: React remounts the element, and a remounted element replays its
      // animation. Restarting a CSS animation in place needs a reflow hack; this needs nothing.
      key={nonce}
      dir="ltr"
      data-testid="die"
      data-value={value}
      className="kesef-die border-hairline bg-tile text-ink grid aspect-square w-12 grid-cols-3 grid-rows-3 place-items-center gap-[2px] rounded-xl border-2 p-[6px] shadow-md"
      style={
        {
          "--kesef-motion-ms": `${String(durationMs)}ms`,
          animationDelay: `${String(delayMs)}ms`,
        } as React.CSSProperties
      }
    >
      {slots === undefined ? (
        // A face the wire invented. Say so rather than drawing a die that does not exist.
        <span className="col-span-3 row-span-3 text-lg font-bold tabular-nums">{value}</span>
      ) : (
        Array.from({ length: 9 }, (_, slot) => (
          <span
            key={slot}
            aria-hidden="true"
            className={slots.includes(slot) ? "kesef-pip" : "kesef-pip-empty"}
          />
        ))
      )}
    </span>
  );
}

export interface SkipAnimationsToggleProps {
  readonly className?: string;
}

/**
 * The persistent "skip animations" switch.
 *
 * Exported on its own so a settings bar can host it instead of, or as well as, the dice tray — the
 * store behind it is module-level, so two copies cannot disagree.
 */
export function SkipAnimationsToggle({ className }: SkipAnimationsToggleProps): React.JSX.Element {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const { chosen, reduced, toggle } = useMotionPreference();

  return (
    <button
      type="button"
      aria-pressed={chosen}
      data-testid="skip-animations"
      onClick={() => {
        toggle();
        // The one thing only this component knows. The roll itself is narrated from the event
        // stream; announcing it here as well would be the double-speak defect.
        announce({
          politeness: "polite",
          key: chosen ? "a11y.animations_on" : "a11y.animations_off",
          params: {},
        });
      }}
      className={`target bg-tile text-ink border-hairline rounded-xl border px-3 py-2 text-sm font-semibold aria-pressed:font-bold ${className ?? ""}`}
    >
      {t("dice.skip_animations")}
      {/* When the OS already asked for stillness the switch is redundant but not disabled: a
          disabled control that looks off would misreport the state the player is actually in. */}
      {reduced && <span className="sr-only"> {t("dice.reduced_motion_active")}</span>}
    </button>
  );
}

export interface DiceTrayProps {
  /** The last roll, or `null`/`undefined` before the first one. Straight off `state.dice`. */
  readonly dice: DiceView | null | undefined;
  /** Full tumble duration in ms. Zero happens by preference, not by passing zero here. */
  readonly tumbleMs?: number;
  /** Render the skip switch alongside the dice. Off if a settings bar owns it instead. */
  readonly withSkipToggle?: boolean;
  /**
   * The animation queue's dice beat (MON-701), when a screen has one.
   *
   * It replaces the signature heuristic below, and it is strictly better: the beat is bumped by a
   * `dice_rolled` **event**, so two identical consecutive rolls tumble twice and a refetch that
   * changes nothing tumbles not at all — the contract gap the note under `signature` records
   * (`DiceView` carries no `roll_seq`), closed from the event stream rather than by adding a field.
   *
   * It cannot gate anything: the faces, the total and the doubles flag are rendered from `DiceView`
   * whatever this is (GAP G-F2).
   */
  readonly settleNonce?: number | undefined;
}

export function DiceTray({
  dice,
  tumbleMs = TUMBLE_MS,
  withSkipToggle = true,
  settleNonce,
}: DiceTrayProps): React.JSX.Element {
  const { t } = useTranslation();
  const { durationMs } = useMotionPreference();

  // A roll's identity, so a re-render for an unrelated reason does not re-tumble. `DiceView` carries
  // no sequence number, so two identical consecutive rolls of the same purpose share an identity and
  // the second does not replay the flourish — a cosmetic miss, and the alternative would be to
  // animate on every refetch. Filed as a contract note: a `roll_seq` on `DiceView` would fix it.
  const signature =
    dice === null || dice === undefined
      ? ""
      : `${String(dice.first)}-${String(dice.second)}-${dice.purpose}`;
  const [nonce, setNonce] = useState(0);
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setNonce((previous) => previous + 1);
    }
  }, [signature]);

  const duration = durationMs(tumbleMs);
  // The queue's beat when there is one, the signature heuristic when there is not, so a tray
  // rendered outside a live game — a test, the setup screen's preview — still tumbles.
  const settle = settleNonce ?? nonce;

  return (
    <div className="flex flex-col items-center gap-2" data-testid="dice-tray">
      <h2 className="text-on-table text-sm font-semibold tracking-wide uppercase">
        {t("dice.label")}
      </h2>

      {dice === null || dice === undefined ? (
        <p className="text-on-table text-sm opacity-80">{t("dice.not_rolled")}</p>
      ) : (
        <>
          <span className="flex items-center gap-3">
            <Die value={dice.first} nonce={settle} durationMs={duration} delayMs={0} />
            <Die value={dice.second} nonce={settle} durationMs={duration} delayMs={70} />
          </span>

          <p className="text-on-table flex flex-col items-center gap-1 text-sm">
            {/* `total` and `is_doubles` come off the wire. Nothing here adds or compares. */}
            <span dir="ltr" className="font-bold tabular-nums" data-testid="dice-total">
              {t("dice.total", { total: dice.total })}
            </span>
            <span className="opacity-80">{t(`dice.purpose.${dice.purpose}`)}</span>
            {dice.is_doubles && (
              <span
                data-testid="dice-doubles"
                className="border-hairline bg-tile text-ink rounded-full border px-2 py-[2px] text-xs font-bold uppercase"
              >
                {t("dice.doubles")}
              </span>
            )}
          </p>
        </>
      )}

      {withSkipToggle && <SkipAnimationsToggle />}
    </div>
  );
}
