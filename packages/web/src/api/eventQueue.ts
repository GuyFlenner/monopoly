/**
 * The event queue: one ordered, de-duplicated log of everything that has happened.
 *
 * Two transports deliver the same `LoggedEvent` envelope — the response to a command and the
 * WebSocket push (MON-303) — so the same `seq` arrives twice as a matter of course, and a
 * reconnect replays a backlog that may overlap what was already seen. De-duplicating on
 * `seq` here is what stops the narration (MON-411) and the animation script (MON-701)
 * playing one roll twice; the server applies the identical rule on its side of the socket
 * (`if pushed.seq <= sent: continue`).
 *
 * **Nothing blocks on a consumer.** `offer` appends and notifies; it never awaits anybody. A
 * consumer either subscribes (and is handed the frames that were just accepted) or holds its
 * own read cursor and calls {@link EventQueue.since}. A slow animation layer therefore falls
 * behind, which is a visual problem, rather than backing up the socket, which would be a
 * correctness one.
 *
 * The log is bounded. A consumer that falls `capacity` events behind has lost frames, and
 * {@link EventQueue.droppedThrough} says so, so a late reader can tell "I have seen
 * everything from here" from "I missed something".
 *
 * There is no game logic in this file: it orders and de-duplicates integers.
 */

import type { LoggedEvent } from "./types";

export type EventListener = (added: readonly LoggedEvent[]) => void;

export const DEFAULT_CAPACITY = 512;

export class EventQueue {
  private entries: LoggedEvent[] = [];
  private highWater = 0;
  private dropped = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  /**
   * The highest `seq` accepted so far — what to pass as `?since=`.
   *
   * Zero means "nothing yet", which is exactly what the server's `since=0` means: replay
   * everything.
   */
  get cursor(): number {
    return this.highWater;
  }

  /** The highest `seq` this log has forgotten. Zero means nothing has been dropped. */
  get droppedThrough(): number {
    return this.dropped;
  }

  /** The retained log, oldest first. */
  get log(): readonly LoggedEvent[] {
    return this.entries;
  }

  /** Everything retained with a `seq` greater than `cursor`, oldest first. */
  since(cursor: number): readonly LoggedEvent[] {
    return this.entries.filter((entry) => entry.seq > cursor);
  }

  /**
   * Accept whatever is new and return it, in `seq` order.
   *
   * Anything at or below the high-water mark is a replay and is dropped. Input order is not
   * trusted — the two transports race, so a command's response can arrive after the socket
   * has already pushed the same frames — which is why this sorts rather than assuming.
   */
  offer(incoming: Iterable<LoggedEvent>): readonly LoggedEvent[] {
    const accepted = [...incoming]
      .filter((entry) => entry.seq > this.highWater)
      .sort((a, b) => a.seq - b.seq);
    if (accepted.length === 0) {
      return [];
    }
    const last = accepted[accepted.length - 1];
    // `accepted` is non-empty, so the last element exists; `noUncheckedIndexedAccess` cannot
    // see that, and a `!` here would be hiding a real case rather than a proven-impossible one.
    if (last !== undefined) {
      this.highWater = last.seq;
    }
    this.entries = [...this.entries, ...accepted];
    this.trim();
    this.notify(accepted);
    return accepted;
  }

  /**
   * Forget everything. Used when the subscription moves to a different game.
   *
   * The cursor goes back to zero with the log, because a cursor into a game we are no longer
   * watching would silently suppress the new game's first events.
   */
  reset(): void {
    this.entries = [];
    this.highWater = 0;
    this.dropped = 0;
  }

  /**
   * Be told about frames as they are accepted. Returns the unsubscribe function.
   *
   * A listener that throws is isolated: one broken consumer must not stop the next one, and
   * must certainly not propagate back into the socket's message handler.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(added: readonly LoggedEvent[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(added);
      } catch {
        // Deliberately swallowed. See `subscribe`.
      }
    }
  }

  private trim(): void {
    if (this.entries.length <= this.capacity) {
      return;
    }
    const overflow = this.entries.length - this.capacity;
    const lastDropped = this.entries[overflow - 1];
    if (lastDropped !== undefined) {
      this.dropped = lastDropped.seq;
    }
    this.entries = this.entries.slice(overflow);
  }
}
