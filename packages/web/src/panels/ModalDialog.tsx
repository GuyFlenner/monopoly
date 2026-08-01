/**
 * The modal focus contract, in one place.
 *
 * Spec §5.5 asks for one shared panel primitive: `role="dialog"`, `aria-modal`, labelled by its
 * own heading, focus moved in on open, trapped while open, restored on close, and Escape that
 * either closes the panel **or says why it cannot**. The auction panel and the trade builder are
 * both modal-shaped, so the contract lives here rather than twice.
 *
 * ## Escape is not always allowed, and that is the interesting case
 *
 * An auction is a phase, not an overlay. While the engine is in `AUCTION` there is nowhere to go
 * back to — dismissing the panel would leave a player looking at a board that is not accepting
 * commands. So `onClose` is *optional*: omit it and the panel is unclosable, Escape narrates
 * `cannotCloseKey` instead of doing nothing, and the same sentence is rendered visibly in the
 * header. Silence on Escape is the failure this shape exists to prevent — a keyboard user
 * presses it, nothing happens, and there is no way to tell "refused" from "broken".
 *
 * ## Why the announcement goes through the Announcer
 *
 * There is no `aria-live` region in this file, and there must never be one: MON-411 owns the two
 * regions at the root and a third would be double-speak (GAP D1/G-54). Nor does this component
 * announce its own *opening* — `PhaseChanged` already does that assertively through
 * `useEventNarration`, and saying "auction" twice is the same defect from the other direction.
 * The only thing it has to say is the refusal, which is a response to a keystroke and therefore
 * `polite`: `assertive` is reserved for the moments the acting player changes.
 *
 * *Visual direction*: the felt darkens and one card of warm stock is laid on top of it, keylined
 * like every other painted area in the product. No animation — a panel that a six-year-old meets
 * under turn pressure should be *there*, not arriving.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAnnounce } from "@/a11y";
import { Icon } from "@/theme";

/**
 * What counts as focusable for the trap.
 *
 * Deliberately the same list a browser would tab through, minus `tabindex="-1"`: a trap that
 * used a shorter list would skip a control the browser still reaches, which is worse than no
 * trap because the focus would leave the dialog from a place nobody tested.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalDialogProps {
  /** The heading, and the dialog's accessible name. One string, so the two cannot diverge. */
  readonly title: string;
  /**
   * How to leave. Omitted (not `undefined`-valued) when the phase forbids leaving, in which case
   * {@link ModalDialogProps.cannotCloseKey} explains that to the player.
   */
  readonly onClose?: (() => void) | undefined;
  /** i18n key for why the panel cannot be left. Rendered visibly *and* announced on Escape. */
  readonly cannotCloseKey?: string | undefined;
  /** Sits beside the heading — the lot, the two traders. Presentation, never a control. */
  readonly headline?: ReactNode;
  readonly children: ReactNode;
  /** The action row. Kept out of `children` so it stays at the end of the tab order. */
  readonly footer?: ReactNode;
}

export function ModalDialog({
  title,
  onClose,
  cannotCloseKey,
  headline,
  children,
  footer,
}: ModalDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // Focus in on open, and back where it came from on close. The ref is captured in the same
  // effect that moves focus so the two can never disagree about what "before" was, and the
  // restore is guarded on the element still being in the document: a panel that outlived the
  // button which opened it would otherwise throw focus into a detached node and land it on
  // `<body>`, which is the exact "where am I?" the contract exists to stop.
  useEffect(() => {
    const previous = document.activeElement;
    restoreTo.current = previous instanceof HTMLElement ? previous : null;
    const root = dialog.current;
    const first = root?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root)?.focus();
    return () => {
      const target = restoreTo.current;
      if (target !== null && target.isConnected) {
        target.focus();
      }
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (onClose !== undefined) {
          onClose();
        } else if (cannotCloseKey !== undefined) {
          announce({ politeness: "polite", key: cannotCloseKey, params: {} });
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const root = dialog.current;
      if (root === null) {
        return;
      }
      const stops = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) {
        // Nothing to tab between: keep focus on the dialog rather than letting it escape to the
        // board behind, which `aria-modal` promises is not there.
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [announce, cannotCloseKey, onClose],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-3 sm:p-6">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
          A dialog is exactly the element that must own key handling: `aria-modal` promises the
          rest of the page is unreachable, and the only way to keep that promise is to catch Tab
          here and to answer Escape. The container is not a control (`tabindex="-1"`, focused
          programmatically), which is what the rule is normally protecting against. */}
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-3xl border-2 border-hairline bg-tile text-ink shadow-2xl"
      >
        {/*
          A `<div>`, not a `<header>` — MON-703's audit finding.

          `<header>` maps to the **banner** landmark unless it is inside sectioning content, and a
          `div[role="dialog"]` is not sectioning content. So this title bar was a second banner on
          every screen that opened a panel (`landmark-no-duplicate-banner`), and inside the chrome's
          own `<header>` — where `<ReplayButton>` lives — it was a banner nested in a banner
          (`landmark-banner-is-top-level`). A dialog's title bar is not the page's banner: the
          heading below is already the dialog's accessible name through `aria-labelledby`, which is
          what a screen reader announces on open, and the landmark added nothing but noise to the
          landmark list. Same reasoning for the footer.
        */}
        <div className="flex items-start gap-3 border-b-2 border-hairline/30 p-4 sm:p-5">
          <div className="grow">
            <h2 id={titleId} className="text-2xl leading-tight font-bold">
              {title}
            </h2>
            {headline !== undefined && <div className="mt-1 text-sm opacity-80">{headline}</div>}
            {onClose === undefined && cannotCloseKey !== undefined && (
              <p className="mt-2 text-sm font-medium opacity-80">{t(cannotCloseKey)}</p>
            )}
          </div>
          {onClose !== undefined && (
            <button
              type="button"
              onClick={onClose}
              className="target flex shrink-0 items-center justify-center rounded-2xl border-2 border-hairline"
            >
              <Icon name="cross" size={20} />
              <span className="sr-only">{t("panel.close")}</span>
            </button>
          )}
        </div>

        <div className="grow overflow-y-auto p-4 sm:p-5">{children}</div>

        {footer !== undefined && (
          /* A `<div>` for the same reason as the title bar above: `<footer>` here would map to the
           **contentinfo** landmark, and a dialog's action row is not the page's footer. */
          <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-hairline/30 p-4 sm:p-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
