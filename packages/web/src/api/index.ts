/** The transport layer. Types from `generated.ts`, one client, one queue, one socket. */

export { ApiClient, DEFAULT_BASE_URL } from "./client";
export type { ApiClientOptions, FetchLike, SocketFactory, SocketLike } from "./client";
export { ApiError, asApiError, isApiError, NO_RESPONSE, TRANSPORT_ERROR_KEY } from "./errors";
export { DEFAULT_CAPACITY, EventQueue } from "./eventQueue";
export type { EventListener } from "./eventQueue";
export { DEFAULT_BACKOFF, EventSocket, parseFrame, TERMINAL_CLOSE_CODES } from "./eventSocket";
export type {
  BackoffPolicy,
  ConnectionState,
  ConnectionStatus,
  EventSocketOptions,
} from "./eventSocket";
export type * from "./types";
