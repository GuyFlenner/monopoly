/**
 * The application shell: two screens, three singletons, and the game id in the URL.
 *
 * ## Two screens
 *
 * `<SetupFlow>` until a game exists, `<GameScreen>` once one does. Nothing routes: there are two
 * states and a game id, and a router would be a dependency earning its keep on one branch.
 *
 * ## Where the game id lives, and why it is not in the store
 *
 * **In the URL, as `?game=<id>`.** The Zustand store is UI-local state in memory, and a reload
 * empties it — which would mean a refresh silently abandoning a game that the server is still
 * holding. The query string survives a reload, a back button and a pasted link, and `GET
 * /games/{id}` rehydrates the whole view from it (`useGame` fetches with `since=0`, so the event
 * log replays too). A query string rather than a path segment because it also survives a static
 * host with no SPA fallback: `/?game=x` is still `/`.
 *
 * ## The singletons, mounted exactly once
 *
 * - `<AnnouncerProvider>` + `<Announcer>` — the product's only two `aria-live` regions (MON-411).
 *   No component below may add another; `App.test.tsx` counts them in the mounted app, because
 *   integration is where the second one reappears (GAP D1/G-54).
 * - `<ThemeSprite>` — the `<defs>` every colour band's `url(#…)` resolves against, document-wide.
 * - The TanStack Query provider, which is in `main.tsx` so that a test can supply its own client.
 *
 * `<GameProvider>` is not a singleton but a per-game one: it owns the socket and the event queue,
 * and it wraps the game screen only.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Announcer, AnnouncerProvider } from "./a11y";
import {
  ApiClient,
  type ApiError,
  type BoardSummary,
  type NewGameRequest,
  type Ruleset,
} from "./api";
import { FailureNote, GameScreen, useReasonText } from "./game/GameScreen";
import { GameProvider, queryKeys } from "./game";
import { applyLocale, type Locale } from "./i18n";
import { SetupScreen } from "./panels/SetupScreen";
import { ThemeSprite } from "./theme";

/** The query parameter carrying the game. One name, read and written in one place. */
export const GAME_PARAM = "game";

function gameIdFromUrl(): string | null {
  return new URLSearchParams(globalThis.location.search).get(GAME_PARAM);
}

/**
 * The game id, held in the address bar.
 *
 * `popstate` is listened to so the back button leaves a game rather than stranding the app on a
 * screen the URL no longer describes.
 */
function useGameIdInUrl(): readonly [string | null, (gameId: string | null) => void] {
  const [gameId, setGameId] = useState<string | null>(gameIdFromUrl);

  useEffect(() => {
    const onPopState = (): void => {
      setGameId(gameIdFromUrl());
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => {
      globalThis.removeEventListener("popstate", onPopState);
    };
  }, []);

  const goTo = useCallback((next: string | null) => {
    const url = new URL(globalThis.location.href);
    if (next === null) {
      url.searchParams.delete(GAME_PARAM);
    } else {
      url.searchParams.set(GAME_PARAM, next);
    }
    globalThis.history.pushState({}, "", url);
    setGameId(next);
  }, []);

  return [gameId, goTo];
}

export interface AppProps {
  /**
   * The transport. Defaults to a client talking to the same-origin API.
   *
   * Injected in tests so the fake `fetch` and the fake socket go in at the edge rather than by
   * mocking a module — the same seam `GameProvider` offers, for the same reason.
   */
  readonly client?: ApiClient;
}

export function App({ client }: AppProps = {}): React.JSX.Element {
  const resolvedClient = useMemo(() => client ?? new ApiClient(), [client]);
  const [gameId, goTo] = useGameIdInUrl();
  const [locale, setLocale] = useState<Locale>("en");

  const switchLocale = useCallback((next: Locale) => {
    setLocale(next);
    applyLocale(next);
  }, []);

  return (
    <AnnouncerProvider>
      {/*
        The product's only two `aria-live` regions, mounted once at the root (MON-411). Every
        component below narrates through `useAnnounce()`; none renders a region of its own,
        because two regions announcing one dice roll is double-speak (GAP D1/G-54).
      */}
      <Announcer />
      {/* The pattern `<defs>` every colour band references by id, document-wide. */}
      <ThemeSprite />

      {gameId === null ? (
        <SetupFlow
          client={resolvedClient}
          locale={locale}
          onLocaleChange={switchLocale}
          onStarted={goTo}
        />
      ) : (
        <GameProvider gameId={gameId} client={resolvedClient}>
          <GameScreen
            onLeave={() => {
              goTo(null);
            }}
          />
        </GameProvider>
      )}
    </AnnouncerProvider>
  );
}

interface SetupFlowProps {
  readonly client: ApiClient;
  readonly locale: Locale;
  readonly onLocaleChange: (locale: Locale) => void;
  readonly onStarted: (gameId: string) => void;
}

/**
 * The setup screen and the two lists it is drawn from.
 *
 * `POST /games` answers with the first `GameView`, so it is written into the cache under the
 * game's key before the screen switches: the board paints from the creation response rather than
 * from a second round trip. `useGame` still refetches — the response is a view, not a lease.
 *
 * The rejection of the POST is *not* handled here. `SetupScreen` catches it and renders the
 * server's `{reason_key, params}` beside its own submit button, which is where a rejected form
 * belongs; swallowing it here would take the message away from the field that caused it.
 */
function SetupFlow({
  client,
  locale,
  onLocaleChange,
  onStarted,
}: SetupFlowProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reasonText = useReasonText();

  const boards = useQuery<BoardSummary[], ApiError>({
    queryKey: queryKeys.boards(),
    queryFn: ({ signal }) => client.listBoards(signal),
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
  });
  const rulesets = useQuery<Ruleset[], ApiError>({
    queryKey: queryKeys.rulesets(),
    queryFn: ({ signal }) => client.listRulesets(signal),
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
  });

  const start = useCallback(
    async (request: NewGameRequest): Promise<void> => {
      const created = await client.createGame(request);
      queryClient.setQueryData(queryKeys.game(created.state.game_id), created);
      onStarted(created.state.game_id);
    },
    [client, queryClient, onStarted],
  );

  const failure = boards.error ?? rulesets.error;

  if (failure !== null) {
    return (
      <Frame>
        <FailureNote
          heading={t("error.title")}
          body={reasonText(failure)}
          action={
            <button
              type="button"
              onClick={() => {
                void boards.refetch();
                void rulesets.refetch();
              }}
              className="target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold"
            >
              {t("label.retry")}
            </button>
          }
        />
      </Frame>
    );
  }

  if (boards.data === undefined || rulesets.data === undefined) {
    return (
      <Frame>
        <p className="text-sm opacity-80">{t("label.loading")}</p>
      </Frame>
    );
  }

  if (boards.data.length === 0) {
    // A server with no boards is not a broken client, and saying so beats an empty picker with a
    // submit button under it that can only ever be refused.
    return (
      <Frame>
        <p className="text-sm opacity-80">{t("setup.no_boards")}</p>
      </Frame>
    );
  }

  return (
    <SetupScreen
      boards={boards.data}
      rulesets={rulesets.data}
      locale={locale}
      onLocaleChange={onLocaleChange}
      onStart={start}
    />
  );
}

/** The setup screen's own container, reused by its loading, empty and error states. */
function Frame({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-start sm:p-6">
      <h1 className="text-3xl font-bold tracking-tight">{t("app.title")}</h1>
      {children}
    </main>
  );
}
