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
import { useCallback, useContext, useSyncExternalStore } from "react";

import type {
  ApiError,
  BoardView,
  Command,
  ConnectionStatus,
  GameStateView,
  GameView,
  LegalityView,
  LoggedEvent,
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
  readonly status: GameStatus;
}

const NO_COMMANDS: readonly Command[] = [];

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
    queryFn: async () => {
      // `since` is the queue's cursor, not a constant: on the first fetch it is 0 and the
      // whole game replays (which is what seeds a reload), and on a refetch it is only the
      // tail. Feeding the result back through the queue is what keeps HTTP and the socket
      // interchangeable — whichever arrives first wins, and the other is de-duplicated.
      const fetched = await client.getGame(gameId, queue.cursor);
      queue.offer(fetched.events);
      return fetched;
    },
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
      queue.offer(applied.events);
    },
    retry: false,
  });

  const events = useSyncExternalStore(
    useCallback((onChange: () => void) => queue.subscribe(onChange), [queue]),
    () => queue.log,
  );

  const send = useCallback((command: Command) => commands.mutateAsync(command), [commands]);
  const validate = useCallback(
    (command: Command) => client.validateCommand(gameId, command),
    [client, gameId],
  );

  return {
    state: view.data?.state,
    board: view.data?.board,
    legalCommands: view.data?.legal_commands ?? NO_COMMANDS,
    send,
    validate,
    events,
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
