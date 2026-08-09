/**
 * `useGame` — the entire game-facing API of this front end, and deliberately a thin one.
 *
 * **The acceptance criterion with teeth: nothing here computes a rule.** There is no
 * comparison of cash against a price, no inference about what is legal, no summing of a
 * player's worth, no counting towards a complete colour group. The projection already ships
 * every one of those (`net_worth`, `group_holdings`, `min_bid`/`max_bid`, `is_ownable`,
 * `total`, `houses_remaining`) precisely so that this file does not have to (ADR-008, G-31).
 * `legalCommands` is handed over verbatim: ADR-005 says the engine decides what is possible
 * and the UI renders what it is given, and the moment a `filter` appears in this file that
 * contract is gone.
 *
 * If a screen needs a number the server does not send, that is a contract gap to file — not
 * an expression to write here.
 *
 * **State comes from the server, always.** A command's response *is* the new view and is
 * written straight into the cache; a WebSocket frame triggers a refetch. Nothing is patched
 * optimistically, because an optimistic patch is a prediction of what the reducer will do,
 * and a prediction of a rule is a copy of it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import type {
  ApiError,
  BoardView,
  Command,
  ConnectionStatus,
  GameStateView,
  GameView,
  LegalityView,
  LoggedEvent,
  SeatClaimView,
} from "@/api";

import { GameContext, type GameContextValue } from "./GameProvider";
import { queryKeys } from "./queryKeys";

/** How the transport is doing. Nothing here is about the game; the game is in `state`. */
export interface GameStatus {
  /** No view has arrived yet. */
  readonly isPending: boolean;
  /** The last fetch failed. `error` says which key to show. */
  readonly isError: boolean;
  /** A command is in flight. Useful for a spinner; never for deciding what is legal. */
  readonly isSending: boolean;
  /** The most recent failure, fetch or command, as a key plus params — never prose. */
  readonly error: ApiError | undefined;
  readonly connection: ConnectionStatus;
  /** The highest event `seq` seen. What a reconnect replays from. */
  readonly cursor: number;
}

export interface UseGameResult {
  /** The projected state, or `undefined` until the first view arrives. */
  readonly state: GameStateView | undefined;
  /** The board: static per game, and the only source of tile names, prices and groups. */
  readonly board: BoardView | undefined;
  /** Exactly what the engine offered, in the engine's order. Never filtered, never sorted. */
  readonly legalCommands: readonly Command[];
  /** Apply a command. Resolves with the server's new view; rejects with an `ApiError`. */
  readonly send: (command: Command) => Promise<GameView>;
  /** Ask whether a command *would* be legal, changing nothing (G-32). */
  readonly validate: (command: Command) => Promise<LegalityView>;
  /** The de-duplicated event log, oldest first — the narration and animation script. */
  readonly events: readonly LoggedEvent[];
  /**
   * Which human seats are taken (ADR-012, MON-906) — the server's projection, copied.
   *
   * A join screen's whole input. Never the secrets; the credential lives inside `ApiClient` and
   * nothing above it can read one.
   */
  readonly claims: readonly SeatClaimView[];
  /**
   * Whether this connection already speaks for a seat in this game (ADR-012, MON-906).
   *
   * Read from `view.speaker` — the server's projection of who this connection is — **not** from
   * whether a secret sits in `localStorage`. That is the root-cause fix (MON-906 review): a stale,
   * voided or replaced secret resolves to `spectator` on the server, so it surfaces here as
   * `seated === false` in the very next view and the seat picker reappears, rather than leaving the
   * holder stranded believing they hold a seat the server has forgotten. A missing `speaker` (an
   * old server across a deploy skew) is treated as seated, since that server has no picker concept
   * and enforces nothing.
   *
   * A boolean rather than the speaker object, so a component still cannot reach for a credential —
   * there is none to reach for now, but the shape keeps it that way.
   */
  readonly seated: boolean;
  /** Take a free seat. Resolves with the view filtered to it; rejects with an `ApiError`. */
  readonly claimSeat: (player: number) => Promise<GameView>;
  readonly status: GameStatus;
  /**
   * Ask for the view again — the retry behind a failed first fetch (MON-708).
   *
   * Exposed rather than left to a caller's own `queryClient.invalidateQueries`, because the query
   * key and the `since` cursor are this hook's business and a screen reproducing either of them is
   * a screen that can get them wrong. Returns `void`: TanStack's promise resolves with the view,
   * and a caller awaiting it would be re-implementing the loading state it already renders.
   */
  readonly refetch: () => void;
}

const NO_COMMANDS: readonly Command[] = [];
const NO_CLAIMS: readonly SeatClaimView[] = [];

export function useGameContext(): GameContextValue {
  const context = useContext(GameContext);
  if (context === null) {
    throw new Error("useGame must be rendered inside a <GameProvider>");
  }
  return context;
}

export function useGame(): UseGameResult {
  const { client, gameId, queue, connection } = useGameContext();
  const queryClient = useQueryClient();

  const view = useQuery<GameView, ApiError>({
    queryKey: queryKeys.game(gameId),
    // `since` is the queue's cursor, not a constant: on the first fetch it is 0 and the whole
    // game replays (which is what seeds a reload), and on a refetch it is only the tail.
    queryFn: () => client.getGame(gameId, queue.cursor),
    // A 4xx will say the same thing three times in a row. Only a server-side failure is worth
    // asking again about, and this is transport policy, not a rule.
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
  });

  const commands = useMutation<GameView, ApiError, Command>({
    mutationFn: (command) => client.submitCommand(gameId, command),
    onSuccess: (applied) => {
      // The server's answer, stored as-is. This is the "view updates from the response"
      // requirement: no merge, no patch, no reconciliation with what we guessed.
      queryClient.setQueryData(queryKeys.game(gameId), applied);
    },
    retry: false,
  });

  // A view's events reach the queue *after* that view has been committed, never during the
  // fetch that produced it. The narration resolves a player's name and a tile's name out of
  // `state` and `board`, so an event announced before its own view is rendered says "0 moved
  // to 2" — which is what this effect, rather than an `offer` inside `queryFn`, prevents. It
  // covers the command path too: `onSuccess` writes the view, and the write lands here.
  useEffect(() => {
    if (view.data !== undefined) {
      queue.offer(view.data.events);
    }
  }, [view.data, queue]);

  const events = useSyncExternalStore(
    useCallback((onChange: () => void) => queue.subscribe(onChange), [queue]),
    () => queue.log,
  );

  // Who the server says this connection is (MON-906 review root-cause fix). `undefined` both before
  // the first view arrives and — at runtime, though the required type does not admit it — when an
  // old server across a deploy skew omits the field. The intermediate name is what lets the
  // `=== undefined` guard read the runtime absence without eslint proving it impossible from the type.
  const speaker = view.data?.speaker;

  // Sweep a *confirmed-dead* credential (ADR-012, MON-906 review, finding 10). If the server resolves
  // this connection to a spectator, any secret this browser still holds for the game is one the
  // server no longer recognises — voided by a release, or lost to a restart — so it is dropped rather
  // than left to accrue as an orphan. This is the right place to forget, not "on leave": a host who
  // leaves and comes back, or loads a save of their own still-live game, needs the secret kept, and
  // only the server can say it is dead. `forgetSeat` is idempotent, so a spectator who never held one
  // is a no-op.
  const isSpectator = speaker !== undefined && speaker.kind === "spectator";
  useEffect(() => {
    if (isSpectator) {
      client.forgetSeat(gameId);
    }
  }, [isSpectator, client, gameId]);

  const send = useCallback((command: Command) => commands.mutateAsync(command), [commands]);
  /**
   * Take a seat, and render from the view the claim answered with (ADR-012).
   *
   * The response is the whole projection — already filtered to the newly claimed seat — so it is
   * written into the cache exactly as a command's response is. No refetch, and nothing patched: the
   * server decided which buttons this connection now has, and a client that guessed would be
   * holding a rule about seat authority.
   */
  const claimSeat = useCallback(
    async (player: number) => {
      const claimed = await client.claimSeat(gameId, player);
      queryClient.setQueryData(queryKeys.game(gameId), claimed);
      return claimed;
    },
    [client, gameId, queryClient],
  );
  const validate = useCallback(
    (command: Command) => client.validateCommand(gameId, command),
    [client, gameId],
  );
  const refetch = useCallback(() => {
    void view.refetch();
  }, [view]);

  return {
    state: view.data?.state,
    board: view.data?.board,
    legalCommands: view.data?.legal_commands ?? NO_COMMANDS,
    send,
    validate,
    events,
    claims: view.data?.claims ?? NO_CLAIMS,
    seated: speaker === undefined || speaker.kind !== "spectator",
    claimSeat,
    refetch,
    status: {
      isPending: view.isPending,
      isError: view.isError,
      isSending: commands.isPending,
      error: commands.error ?? view.error ?? undefined,
      connection,
      cursor: queue.cursor,
    },
  };
}
