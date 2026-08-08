/** The transport layer. Types from `generated.ts`, one client, one queue, one socket. */

export { ApiClient, DEFAULT_BASE_URL } from "./client";
export type { ApiClientOptions, FetchLike, SocketFactory, SocketLike } from "./client";
export { ApiError, asApiError, isApiError, NO_RESPONSE, TRANSPORT_ERROR_KEY } from "./errors";
export { DEFAULT_CAPACITY, EventQueue } from "./eventQueue";
export type { EventListener } from "./eventQueue";
export {
  CLOSE_REASON_KEYS,
  closeReasonKey,
  DEFAULT_BACKOFF,
  EventSocket,
  parseFrame,
  TERMINAL_CLOSE_CODES,
  WS_CURSOR_RESET,
  WS_GAME_NOT_FOUND,
  WS_MALFORMED_REQUEST,
  WS_TOO_MANY_WATCHERS,
  WS_WATCHER_TOO_SLOW,
} from "./eventSocket";
export type {
  BackoffPolicy,
  ConnectionState,
  ConnectionStatus,
  EventSocketOptions,
} from "./eventSocket";
export type * from "./types";
