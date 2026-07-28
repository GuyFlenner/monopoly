/**
 * The one place a game's transport is wired up: client, event queue, live subscription.
 *
 * It is a provider rather than a hook body so that the queue and the socket have the game's
 * lifetime rather than a component's — the narration (MON-411) and the animation script
 * (MON-701) both read the same queue, and two components each opening their own socket would
 * hand each of them a different half of the event stream.
 *
 * Everything injectable is injected: the `client` carries its own `fetch` and its own socket
 * factory (see `api/client.ts`), so a test drives the real code path with fakes at the edge
 * instead of mocking this provider out.
 */

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ApiClient, EventQueue, EventSocket } from "@/api";
import type { ConnectionStatus, GameView, LoggedEvent } from "@/api";

import { queryKeys } from "./queryKeys";

export interface GameContextValue {
  readonly client: ApiClient;
  readonly gameId: string;
  readonly queue: EventQueue;
  readonly connection: ConnectionStatus;
}

export const GameContext = createContext<GameContextValue | null>(null);

const INITIAL_CONNECTION: ConnectionStatus = {
  state: "idle",
  attempts: 0,
  closeCode: undefined,
  reasonKey: undefined,
};

/** Reconnect tuning. Present so a test does not have to wait ten real seconds. */
export interface BackoffOverrides {
  readonly initialMs?: number;
  readonly maxMs?: number;
  readonly factor?: number;
  readonly random?: () => number;
}

export interface GameProviderProps {
  readonly gameId: string;
  /** Defaults to a client talking to the same-origin API. */
  readonly client?: ApiClient;
  readonly backoff?: BackoffOverrides;
  readonly children: ReactNode;
}

export function GameProvider({
  gameId,
  client,
  backoff,
  children,
}: GameProviderProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionStatus>(INITIAL_CONNECTION);

  const resolvedClient = useMemo(() => client ?? new ApiClient(), [client]);
  const queue = useQueueForGame(gameId);

  // The socket reads the cursor at connect time, so it needs the current queue without being
  // re-created on every render. Refs are that seam; the backoff goes through one too, so an
  // inline `backoff={{...}}` prop cannot silently tear the subscription down each render.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const backoffRef = useRef(backoff);
  backoffRef.current = backoff;

  useEffect(() => {
    const tuning = backoffRef.current;
    const socket = new EventSocket({
      open: (since) => resolvedClient.openEventStream(gameId, since),
      cursor: () => queueRef.current.cursor,
      onFrames: (frames) => {
        const accepted = queueRef.current.offer(frames);
        if (accepted.length > 0) {
          refreshIfBehind(queryClient, gameId, accepted);
        }
      },
      onStatus: setConnection,
      ...(tuning?.random === undefined ? {} : { random: tuning.random }),
      backoff: {
        ...(tuning?.initialMs === undefined ? {} : { initialMs: tuning.initialMs }),
        ...(tuning?.maxMs === undefined ? {} : { maxMs: tuning.maxMs }),
        ...(tuning?.factor === undefined ? {} : { factor: tuning.factor }),
      },
    });
    socket.start();
    return () => {
      socket.stop();
    };
  }, [resolvedClient, gameId, queryClient]);

  const value = useMemo<GameContextValue>(
    () => ({ client: resolvedClient, gameId, queue, connection }),
    [resolvedClient, gameId, queue, connection],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

/**
 * One queue per game id, created lazily and replaced when the id changes.
 *
 * A cursor into a game we are no longer watching would suppress the *new* game's opening
 * events — they start at `seq` 1, which every old cursor is above.
 */
function useQueueForGame(gameId: string): EventQueue {
  const held = useRef<{ id: string; queue: EventQueue } | null>(null);
  if (held.current === null || held.current.id !== gameId) {
    held.current = { id: gameId, queue: new EventQueue() };
  }
  return held.current.queue;
}

/**
 * A frame arrived that the cached view does not yet account for, so ask the server again.
 *
 * The refetch — rather than patching the cached view from the event — is the whole of ADR-008
 * on this side of the wire: an event says what happened, the *view* says what is now true,
 * and reconstructing the second from the first would be re-implementing the reducer in
 * TypeScript. The comparison against `event_cursor` is only there to skip the round trip when
 * the frame is the socket's echo of a command whose response already updated the cache.
 */
function refreshIfBehind(
  queryClient: QueryClient,
  gameId: string,
  accepted: readonly LoggedEvent[],
): void {
  const key = queryKeys.game(gameId);
  const cached = queryClient.getQueryData<GameView>(key);
  const highest = accepted.reduce((max, entry) => Math.max(max, entry.seq), 0);
  if (cached !== undefined && cached.event_cursor >= highest) {
    return;
  }
  void queryClient.invalidateQueries({ queryKey: key });
}
