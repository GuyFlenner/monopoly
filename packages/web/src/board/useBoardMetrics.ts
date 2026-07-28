/**
 * How wide the board actually is, and therefore whether its squares may be touched.
 *
 * The 44 px hit-target floor and an eleven-column grid are in arithmetic conflict below 484 px, and
 * the spec's resolution is that the squares stop being tap targets rather than that the floor bends
 * (GAP G-C1/G-53). Which means something has to *know* the width, and it cannot be a viewport media
 * query: the board is a component and may sit in a column narrower than the window. So this measures
 * the element.
 *
 * `ResizeObserver` where it exists, one `getBoundingClientRect()` where it does not. jsdom has
 * neither a layout engine nor the observer, so under Vitest the measurement is `0` — which resolves
 * to *not interactive*, the fail-safe direction: no tap target is offered until we have proof one
 * would meet the floor. MON-707's Playwright run is where the geometry is measured for real.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MIN_TARGET_PX } from "@/theme";

import { GRID_SPAN, interactiveMinInlineSize } from "./geometry";

/** 484 px: eleven columns of the accessibility floor. Derived, so raising the floor moves it. */
export const INTERACTIVE_MIN_INLINE_PX = interactiveMinInlineSize(MIN_TARGET_PX);

export interface BoardMetrics {
  /** Attach to the element whose inline size decides everything below. */
  readonly measure: (node: HTMLElement | null) => void;
  /** Measured inline size in CSS px; `0` before the first measurement. */
  readonly inlineSize: number;
  /** One square's inline size in CSS px. */
  readonly tileInlineSize: number;
  /** Whether a square may be a hit target here. See the module docstring. */
  readonly interactive: boolean;
}

export function useBoardMetrics(): BoardMetrics {
  const [inlineSize, setInlineSize] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  const measure = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) {
      return;
    }
    setInlineSize(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const next = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) {
        // `contentBoxSize` is the inline size in the element's own writing mode, so it is already
        // the right number in Hebrew; `contentRect.width` would not be.
        const box = entry.contentBoxSize[0];
        setInlineSize(box?.inlineSize ?? entry.contentRect.width);
      }
    });
    next.observe(node);
    observer.current = next;
  }, []);

  return {
    measure,
    inlineSize,
    tileInlineSize: inlineSize / GRID_SPAN,
    interactive: inlineSize >= INTERACTIVE_MIN_INLINE_PX,
  };
}
