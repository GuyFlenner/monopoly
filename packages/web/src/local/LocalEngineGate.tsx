/**
 * The screen between "the page loaded" and "the rules engine is ready" (MON-805).
 *
 * In the local build the engine is a CPython build plus two wheels, fetched over a CDN. That is a
 * few megabytes on a first visit and cached on the next, and a few megabytes of blank page is
 * indistinguishable from a broken deployment. So there is a real loading state, it says which stage
 * it is on, and a failure is a keyed message with a retry rather than a white screen.
 *
 * It renders no game and knows no rules: it produces an `ApiClient` and hands it to `<App>`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "@/api";

import { LOAD_STAGES, type LoadEngineOptions } from "./engine";

/** What the gate is doing. `stageKey` is a catalogue key, never a sentence. */
type Progress =
  | { readonly phase: "loading"; readonly stageKey: string }
  | { readonly phase: "ready"; readonly client: ApiClient }
  | { readonly phase: "failed" };

export interface LocalEngineGateProps {
  /** Injected in tests. In the app it is `startLocalEngine` from this package's index. */
  readonly start: (options: LoadEngineOptions) => Promise<ApiClient>;
  readonly children: (client: ApiClient) => ReactNode;
}

export function LocalEngineGate({ start, children }: LocalEngineGateProps): React.JSX.Element {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<Progress>({
    phase: "loading",
    stageKey: LOAD_STAGES.runtime,
  });
  const [attempt, setAttempt] = useState(0);

  // The loader is held in a ref so that a parent re-rendering with a new inline `start` prop cannot
  // restart a multi-megabyte download. `attempt` is the only thing that legitimately triggers one.
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    let live = true;
    setProgress({ phase: "loading", stageKey: LOAD_STAGES.runtime });
    startRef
      .current({
        onProgress: (stageKey) => {
          if (live) {
            setProgress({ phase: "loading", stageKey });
          }
        },
      })
      .then((client) => {
        if (live) {
          setProgress({ phase: "ready", client });
        }
      })
      .catch((cause: unknown) => {
        // Logged, not rendered. The cause is a `PythonError`, a 404 for a wheel or a CDN failure —
        // all developer-facing English, and none of it a thing to show a child. The player gets a
        // key and a button.
        console.error("[local engine] failed to load", cause);
        if (live) {
          setProgress({ phase: "failed" });
        }
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  if (progress.phase === "ready") {
    return <>{children(progress.client)}</>;
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-start sm:p-6">
      <h1 className="text-3xl font-bold tracking-tight">{t("app.title")}</h1>
      {progress.phase === "loading" ? (
        <>
          {/*
            The one sanctioned exception to "no `aria-live` outside the root `<Announcer>`"
            (MON-745; see the exception recorded in `a11y/Announcer.tsx`). This screen exists
            because there is no `<App>` yet — `shell.tsx` renders `<LocalEngineGate>` *around*
            `<App>`, not inside it, so there is no `<AnnouncerProvider>` above this component to
            narrate through. `useOptionalAnnounce` cannot fix that: it would fall silent for the
            whole load, trading a real accessibility need (a multi-second wait, worth saying so)
            for architectural purity with no listener left to benefit from it.

            What makes this safe rather than a second copy of the same defect: the two regions
            are never both mounted. The instant `phase` reaches "ready" this branch stops
            rendering — see the early return above — and `children(client)` (`<App>`, with the
            real `<Announcer>` inside it) takes over completely. `localTransport.test.tsx`'s "the
            loading gate" suite asserts that invariant directly; treat it as load-bearing before
            changing either file's narration.
          */}
          <p className="text-sm font-semibold" aria-live="polite">
            {t(progress.stageKey)}
          </p>
          <p className="text-sm opacity-80">{t("engine.local.note")}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold">{t("engine.local.failed")}</p>
          <p className="text-sm opacity-80">{t("engine.local.failed_note")}</p>
          <button
            type="button"
            onClick={retry}
            className="target bg-tile text-ink border-hairline self-start rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {t("label.retry")}
          </button>
        </>
      )}
    </main>
  );
}
