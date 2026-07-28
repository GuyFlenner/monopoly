/**
 * The reconnecting WebSocket subscription.
 *
 * The socket's whole job is to hand frames to the {@link EventQueue} and to keep existing.
 * It holds no game state, and losing it changes nothing about the game: a disconnect removes
 * a mailbox on the server (see `api.py`) and, here, starts a backoff. When it comes back it
 * reconnects with `?since=` the queue's cursor, so the backlog is replayed and the queue
 * de-duplicates the overlap. That is the entire recovery story, and it is why nothing in this
 * file writes to state.
 *
 * The server's application-range close codes are treated as data, not as prose: 4404 and 4429
 * mean "do not come back", 4413 means "you fell behind, come back and replay". The keyed
 * reason string is carried out on the status untranslated — this module owns no catalogue.
 */

import type { SocketLike } from "./client";
import type { LoggedEvent } from "./types";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** How many consecutive failed attempts. Zero once a connection opens. */
  readonly attempts: number;
  /** The close code of the last close, if there was one. */
  readonly closeCode: number | undefined;
  /**
   * The server's close reason, which is an i18n key (`error.too_many_watchers`).
   *
   * Not translated here, and not translated by the socket's owner either: the catalogue does
   * not yet carry the WebSocket close keys. See the note in `useGame.ts`.
   */
  readonly reasonKey: string | undefined;
}

/** Close codes after which reconnecting cannot help. Mirrors `api.py`'s WS_* constants. */
export const TERMINAL_CLOSE_CODES: readonly number[] = [
  4404, // WS_GAME_NOT_FOUND — the game is gone; a retry loop would hammer a 404 forever.
  4429, // WS_TOO_MANY_WATCHERS — the cap is not going to move because we asked again.
  4422, // WS_MALFORMED_REQUEST — the handshake itself was wrong; the same one will be too.
];

export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 500, maxMs: 10_000, factor: 2 };

export interface EventSocketOptions {
  /** Open a socket replaying from `since`. Normally `client.openEventStream`. */
  readonly open: (since: number) => SocketLike;
  /** Where to replay from — read at connect time, so it is always the queue's latest. */
  readonly cursor: () => number;
  readonly onFrames: (frames: readonly LoggedEvent[]) => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  readonly backoff?: Partial<BackoffPolicy>;
  /** Jitter source, in `[0, 1)`. Injected so a test can pin the delay. */
  readonly random?: () => number;
}

export class EventSocket {
  private readonly options: EventSocketOptions;
  private readonly backoff: BackoffPolicy;
  private readonly random: () => number;

  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private attempts = 0;
  private state: ConnectionState = "idle";
  private closeCode: number | undefined;
  private reasonKey: string | undefined;

  constructor(options: EventSocketOptions) {
    this.options = options;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.random = options.random ?? Math.random;
  }

  get status(): ConnectionStatus {
    return {
      state: this.state,
      attempts: this.attempts,
      closeCode: this.closeCode,
      reasonKey: this.reasonKey,
    };
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  /**
   * Stop for good: no further reconnect, and the live socket is closed.
   *
   * Idempotent, because React will call it from a cleanup that may run twice under Strict
   * Mode, and a second close must not schedule a first reconnect.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      detach(socket);
      socket.close();
    }
    this.publish("closed");
  }

  /** The delay before attempt number `attempt` (1-based), with full jitter. */
  delayFor(attempt: number): number {
    const ceiling = Math.min(
      this.backoff.maxMs,
      this.backoff.initialMs * Math.pow(this.backoff.factor, attempt - 1),
    );
    // Full jitter rather than a fixed ladder: six seats reconnecting after one dropped
    // network would otherwise all retry on the same millisecond, forever.
    return Math.round(ceiling * (0.5 + 0.5 * this.random()));
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.publish(this.attempts === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = this.options.open(this.options.cursor());
    } catch {
      // A constructor that throws (a malformed URL, a blocked scheme) is a failed attempt
      // like any other, not a crash in whatever rendered us.
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.closeCode = undefined;
      this.reasonKey = undefined;
      this.publish("open");
    };
    socket.onmessage = (event) => {
      const frame = parseFrame(event.data);
      if (frame !== null) {
        this.options.onFrames([frame]);
      }
    };
    socket.onerror = () => {
      // `onclose` always follows `onerror`, and it is the one carrying the code. Nothing to
      // do here but refuse to treat an error as a second, codeless disconnect.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) {
        return; // a stale handler from a socket we already replaced
      }
      this.socket = null;
      detach(socket);
      this.closeCode = event.code;
      this.reasonKey = event.reason === "" ? undefined : event.reason;
      if (this.stopped || TERMINAL_CLOSE_CODES.includes(event.code)) {
        this.publish("closed");
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      return;
    }
    this.attempts += 1;
    this.publish("reconnecting");
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.delayFor(this.attempts));
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private publish(state: ConnectionState): void {
    this.state = state;
    this.options.onStatus?.(this.status);
  }
}

function detach(socket: SocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

/**
 * Parse one WebSocket frame into a `LoggedEvent`, or `null` if it is not one.
 *
 * Structural rather than exhaustive: `seq` must be a positive integer and `event` must carry
 * a string `type`, because those two are what the queue and the narration index on. Anything
 * else is dropped instead of thrown — a single malformed frame must not take down a
 * subscription that is otherwise fine, and a `null` here is visible as a missing event rather
 * than as a blank screen.
 */
export function parseFrame(data: unknown): LoggedEvent | null {
  if (typeof data !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as { seq?: unknown; event?: unknown };
  if (typeof candidate.seq !== "number" || !Number.isInteger(candidate.seq) || candidate.seq < 1) {
    return null;
  }
  if (typeof candidate.event !== "object" || candidate.event === null) {
    return null;
  }
  if (typeof (candidate.event as { type?: unknown }).type !== "string") {
    return null;
  }
  return parsed as LoggedEvent;
}
