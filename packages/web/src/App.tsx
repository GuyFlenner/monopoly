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
  type RulesetView,
} from "./api";
import { GameScreen } from "./game/GameScreen";
import { GameProvider, queryKeys } from "./game";
import { type Locale } from "./i18n";
import { useLocale } from "./i18n/useLocale";
import { LoadSavedGame } from "./panels/LoadSavedGame";
import { SetupScreen } from "./panels/SetupScreen";
import { EmptyState, ErrorState, LoadingState } from "./panels/States";
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
  // Read from i18next, not held beside it. Two controls can change the language now — the setup
  // screen's radio group and the game chrome's switch — and a copy in this component is how the
  // one that did not fire ends up displaying a language the page is no longer in.
  const [locale, switchLocale] = useLocale();

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
  const queryClient = useQueryClient();

  const boards = useQuery<BoardSummary[], ApiError>({
    queryKey: queryKeys.boards(),
    queryFn: ({ signal }) => client.listBoards(signal),
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
  });
  const rulesets = useQuery<RulesetView[], ApiError>({
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

  /**
   * Restore a save (MON-704).
   *
   * The response is a `GameView` exactly as `POST /games` returns one, so it is cached under the
   * game's key and the screen switches — the identical two lines `start` runs. That is the whole of
   * "a loaded game is just a game": nothing downstream of here has a branch for it.
   */
  const load = useCallback(
    async (save: unknown): Promise<void> => {
      const restored = await client.loadGame(save);
      queryClient.setQueryData(queryKeys.game(restored.state.game_id), restored);
      onStarted(restored.state.game_id);
    },
    [client, queryClient, onStarted],
  );

  const failure = boards.error ?? rulesets.error;

  if (failure !== null) {
    return (
      <Frame>
        <ErrorState
          error={failure}
          testId="setup-error"
          onRetry={() => {
            void boards.refetch();
            void rulesets.refetch();
          }}
        />
        {/*
          Reachable even when the two lists failed, and that is the point of putting it here as well
          as inside `SetupScreen`: loading a save needs neither `/boards` nor `/rulesets` — the board
          and the rule set are *in the file* — so a server that cannot list its boards is still a
          server that can resume yesterday's game. Hiding the one working affordance behind an
          unrelated failure is the "no spinners forever" defect wearing an error message.
        */}
        <LoadSavedGame onLoad={load} />
      </Frame>
    );
  }

  if (boards.data === undefined || rulesets.data === undefined) {
    return (
      <Frame>
        <LoadingState testId="setup-loading" />
      </Frame>
    );
  }

  /*
    Only boards whose squares have names (MON-419, G-46).

    `catalogue_ready` is the server's flag, copied from the board data — the one place that can know,
    since the names live in this package's catalogues and the server cannot read them. A board
    without it would paint forty blank squares, which is the failure the `i18n.exists` guards in the
    log, the action bar and the dossier exist to *survive* rather than to make acceptable.

    Filtered here rather than inside `SetupScreen` so that the "no boards" state below covers both
    causes with one sentence: a server with no boards and a server whose boards are all unnamed are
    the same thing from a parent's side, and both beat an empty picker with a submit button under it.
  */
  const playable = boards.data.filter((board) => board.catalogue_ready);

  if (playable.length === 0) {
    return (
      <Frame>
        <EmptyState messageKey="setup.no_boards" testId="setup-empty" />
        {/* A save carries its own board, so this works with an empty picker. See above. */}
        <LoadSavedGame onLoad={load} />
      </Frame>
    );
  }

  return (
    <SetupScreen
      boards={playable}
      rulesets={rulesets.data}
      locale={locale}
      onLocaleChange={onLocaleChange}
      onStart={start}
      onLoad={load}
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
