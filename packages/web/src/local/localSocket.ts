/**
 * The event stream, without a socket.
 *
 * `ApiClient` opens its event stream through an injected `createSocket` factory and only ever uses
 * four handlers and `close()` (the `SocketLike` interface in `api/client.ts` exists for exactly
 * this). So the local build supplies a `SocketLike` that reads the log out of the rules engine in
 * this tab, and `EventSocket`, `EventQueue`, the narration and the animation queue above it are
 * unchanged and unaware.
 *
 * ## The two halves
 *
 * {@link LocalEventBus} owns the *when*: it holds the subscribers, replays the log to each of them
 * from its own cursor, and runs the bot pump after a command. {@link LocalSocket} owns one
 * subscription's lifetime and its handlers. They are separate because the pump belongs to the game
 * and the handlers belong to the component that mounted — a socket that owned the pump would stop
 * a bot mid-turn when React remounted a provider.
 *
 * ## Delivery is cursor-driven, never push-driven
 *
 * A step returns the events it appended, and this file ignores them: every delivery is
 * `events_since(gameId, subscriberCursor)`. That is the same choice `api.stream_events` makes for
 * the same reason — a subscription opened halfway through a bot's turn, or one that reconnected
 * after a backoff, must receive the backlog rather than only what happened after it arrived. It also
 * means a duplicate delivery is impossible rather than de-duplicated downstream.
 *
 * ## Pacing
 *
 * The thinking delay is awaited inside the Python step, not here. So this loop is `while (!done)`
 * with no timers of its own, and the tab stays responsive because each iteration is one `await`.
 * Nothing here decides how fast a bot plays; `Settings.bot_think_seconds` does.
 */

import type { SocketFactory, SocketLike } from "@/api";

import { asBotStep, asEventBatch, parseEnvelope, type PyBridge } from "./bridge";

/** Close codes mirroring `api.py`'s `WS_*` constants. `eventSocket.ts` treats 4404 as terminal. */
export const LOCAL_WS_GAME_NOT_FOUND = 4404;
const NORMAL_CLOSURE = 1000;

/** One live listener. The cursor is read at delivery time, so it is always the latest. */
interface Subscriber {
  readonly deliver: (frames: readonly unknown[]) => void;
  readonly cursor: () => number;
  readonly gone: (code: number, reason: string) => void;
}

/**
 * The game's event fan-out and its bot pump, for one page.
 *
 * Not a class per socket: `GameProvider` may mount and unmount a subscription several times over
 * one game's life (React Strict Mode does it twice on purpose), and a pump that stopped with a
 * subscription would leave a bot frozen mid-turn.
 */
export class LocalEventBus {
  private readonly bridge: PyBridge;
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly pumping = new Set<string>();

  constructor(bridge: PyBridge) {
    this.bridge = bridge;
  }

  subscribe(gameId: string, subscriber: Subscriber): () => void {
    const held = this.subscribers.get(gameId) ?? new Set<Subscriber>();
    held.add(subscriber);
    this.subscribers.set(gameId, held);
    return () => {
      held.delete(subscriber);
      if (held.size === 0) {
        this.subscribers.delete(gameId);
      }
    };
  }

  /**
   * Deliver everything each listener has not yet seen.
   *
   * A listener whose replay comes back as anything but a batch is told to go away with the close
   * code its HTTP counterpart would have used, rather than being left open on a game that is gone.
   */
  async deliver(gameId: string): Promise<void> {
    for (const subscriber of [...(this.subscribers.get(gameId) ?? [])]) {
      const envelope = parseEnvelope(await this.bridge.eventsSince(gameId, subscriber.cursor()));
      const batch = asEventBatch(envelope.body);
      if (batch === null) {
        subscriber.gone(LOCAL_WS_GAME_NOT_FOUND, "error.game_not_found");
        continue;
      }
      if (batch.events.length > 0) {
        subscriber.deliver(batch.events);
      }
    }
  }

  /**
   * Let every bot that can act do so, delivering each move as it happens (MON-304).
   *
   * Called after a command, and after a game is created, because both are points at which the table
   * may have been handed to a computer. The delivery *before* the loop is not redundant: a command's
   * own events reach the caller in the command's response, but a second listener — another tab-local
   * subscription, a provider that just remounted — has only this.
   *
   * Re-entrant calls are dropped rather than queued. The Python side holds the authoritative lock
   * (one per game); this set only avoids two JavaScript loops racing to deliver the same frames.
   */
  async pump(gameId: string): Promise<void> {
    await this.deliver(gameId);
    if (this.pumping.has(gameId)) {
      return;
    }
    this.pumping.add(gameId);
    try {
      for (;;) {
        const envelope = parseEnvelope(await this.bridge.advanceBotsStep(gameId));
        const step = asBotStep(envelope.body);
        if (step === null || step.done) {
          // `null` covers the 404 of a game that was left mid-turn — a real sequence, because a
          // bot's pause is measured in tenths of a second and "leave game" is one click.
          break;
        }
        await this.deliver(gameId);
      }
    } finally {
      this.pumping.delete(gameId);
    }
  }
}

/**
 * One subscription, shaped like the `WebSocket` `EventSocket` expects.
 *
 * Opening is deferred to a microtask so a caller can attach its handlers to the returned object
 * before anything is delivered to them — a real `WebSocket` never fires `onopen` synchronously from
 * its constructor either, and `EventSocket.connect` assigns its handlers after `open()` returns.
 */
export class LocalSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  private readonly bus: LocalEventBus;
  private readonly gameId: string;
  private cursor: number;
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(bus: LocalEventBus, gameId: string, since: number) {
    this.bus = bus;
    this.gameId = gameId;
    this.cursor = since;
    queueMicrotask(() => {
      this.open();
    });
  }

  close(code?: number, reason?: string): void {
    this.finish(code ?? NORMAL_CLOSURE, reason ?? "", true);
  }

  private open(): void {
    if (this.closed) {
      return;
    }
    this.unsubscribe = this.bus.subscribe(this.gameId, {
      cursor: () => this.cursor,
      deliver: (frames) => {
        this.push(frames);
      },
      gone: (code, reason) => {
        this.finish(code, reason, false);
      },
    });
    this.onopen?.({ type: "open" });
    // The backlog after `?since=`, exactly as `stream_events` replays it before going live.
    void this.bus.deliver(this.gameId);
  }

  /**
   * Hand each frame over as the string a real socket would have carried.
   *
   * `eventSocket.parseFrame` accepts a string and nothing else, deliberately, so serializing here
   * keeps that guard doing its job instead of routing around it with a pre-parsed object.
   */
  private push(frames: readonly unknown[]): void {
    for (const frame of frames) {
      if (this.closed) {
        return;
      }
      const seq = (frame as { seq?: unknown }).seq;
      if (typeof seq === "number" && seq > this.cursor) {
        this.cursor = seq;
      }
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onclose?.({ code, reason, wasClean });
  }
}

/**
 * The `createSocket` option for a local `ApiClient`.
 *
 * The URL is the one `ApiClient.eventStreamUrl` built — `ws://…/api/games/{id}/ws?since=N`. It is
 * parsed rather than ignored so the *client* stays the single owner of what a stream URL looks like:
 * this factory reads the id and the cursor out of it and knows nothing else about the route.
 */
export function createLocalSocketFactory(bus: LocalEventBus): SocketFactory {
  return (url: string): SocketLike => {
    const parsed = new URL(url);
    const match = /\/games\/([^/]+)\/ws$/.exec(parsed.pathname);
    const gameId = match === null ? "" : safeDecode(match[1] ?? "");
    const since = Number.parseInt(parsed.searchParams.get("since") ?? "0", 10);
    return new LocalSocket(bus, gameId, Number.isFinite(since) && since > 0 ? since : 0);
  };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
