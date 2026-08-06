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

import { Announcer, AnnouncerProvider, SCREEN_HEADING_ATTRIBUTE, useScreenFocus } from "./a11y";
import {
  ApiClient,
  type ApiError,
  type BoardSummary,
  type IfExists,
  type NewGameRequest,
  type RulesetView,
} from "./api";
import { GameScreen } from "./game/GameScreen";
import { GameProvider, queryKeys } from "./game";
import { canPlayOnline, type Transport } from "./local/mode";
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
   *
   * This is the **same-screen** transport. A game started for people elsewhere goes to an
   * `ApiClient` of this component's own making, because the point of that control is to reach a
   * server rather than whatever was injected here (MON-728).
   */
  readonly client?: ApiClient;
  /**
   * Offer the choice between playing here and playing with people elsewhere (MON-728).
   *
   * Defaults to {@link canPlayOnline}, which is true only for a build that has both an in-tab engine
   * and an API URL — the published one. A prop so a test can render either answer without a build,
   * and so the affordance is *absent* rather than broken where it could not work.
   */
  readonly offerOnline?: boolean;
}

export function App({ client, offerOnline = canPlayOnline() }: AppProps = {}): React.JSX.Element {
  const sameScreenClient = useMemo(() => client ?? new ApiClient(), [client]);
  /*
    The API, for a game being started for people elsewhere (MON-728).

    Built even when it is not used — an `ApiClient` is a couple of fields and a `fetch` reference, not
    a connection, so there is nothing to open lazily. Its base URL is `defaultBaseUrl()`, which is
    `VITE_API_URL` on the published build and `/api` in dev.
  */
  const onlineClient = useMemo(() => new ApiClient(), []);
  /*
    Which engine this session is talking to.

    Only ever changed *before* a game exists, by the setup screen's control. Once a game has been
    created the id is in the URL, and a reload re-decides from scratch in `shell.tsx` — where the
    answer is the same one, because a game created online is not in this browser's save slot. So this
    piece of state cannot drift from what a reload would do, which is the property that makes the
    address bar a link somebody can send.
  */
  const [transport, setTransport] = useState<Transport>("same-screen");
  const resolvedClient = transport === "online" ? onlineClient : sameScreenClient;
  const [gameId, goTo] = useGameIdInUrl();
  // Read from i18next, not held beside it. Two controls can change the language now — the setup
  // screen's radio group and the game chrome's switch — and a copy in this component is how the
  // one that did not fire ends up displaying a language the page is no longer in.
  const [locale, switchLocale] = useLocale();

  /*
    Where the keyboard goes when the screen swaps (MON-703).

    Called here because this is the component that *knows* the screen changed — the id in the URL is
    the whole of the routing, so `gameId` is the screen. See `a11y/screenFocus.ts` for the defect: a
    swap unmounts a whole screen, the focused button goes with it, and the browser drops focus to
    `<body>`, from where Tab starts again at the top of the page.
  */
  useScreenFocus(gameId ?? "setup");

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
          transport={transport}
          onTransportChange={offerOnline ? setTransport : undefined}
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
  /** Which engine `client` speaks to — the cache scope for the two lists (MON-728). */
  readonly transport: Transport;
  /**
   * Offer the where-do-people-play control, and take its answer. Omitted where there is no choice.
   *
   * Optional rather than paired with a boolean: "no handler" and "no control" are the same thing,
   * and a screen cannot then be given a switch that changes nothing.
   */
  readonly onTransportChange?: ((transport: Transport) => void) | undefined;
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
  transport,
  onTransportChange,
  locale,
  onLocaleChange,
  onStarted,
}: SetupFlowProps): React.JSX.Element {
  const queryClient = useQueryClient();

  const boards = useQuery<BoardSummary[], ApiError>({
    queryKey: queryKeys.boards(transport),
    queryFn: ({ signal }) => client.listBoards(signal),
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
  });
  const rulesets = useQuery<RulesetView[], ApiError>({
    queryKey: queryKeys.rulesets(transport),
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
    async (save: unknown, ifExists?: IfExists): Promise<void> => {
      // `restored.state.game_id`, not the id inside the file: an `if_exists=copy` load is seated
      // under a freshly minted id (ADR-011), and the response is the only thing that knows it. The
      // URL and the cache key both come from here, so a copy is addressable and reloadable like any
      // other game without this layer knowing that a copy is a thing.
      const restored = await client.loadGame(save, ifExists);
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
      transport={transport}
      onTransportChange={onTransportChange}
    />
  );
}

/** The setup screen's own container, reused by its loading, empty and error states. */
function Frame({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-start sm:p-6">
      {/* `tabIndex={-1}` and the marker so a screen change can land focus here — see
          `a11y/screenFocus.ts`. Focusable programmatically, never a tab stop. */}
      <h1
        {...{ [SCREEN_HEADING_ATTRIBUTE]: "" }}
        tabIndex={-1}
        className="text-3xl font-bold tracking-tight"
      >
        {t("app.title")}
      </h1>
      {children}
    </main>
  );
}
