/**
 * What an announcement is, and the bus that carries one to the single `<Announcer>`.
 *
 * The bus is a pub/sub rather than React state on purpose: the context value handed to the
 * tree never changes, so pushing an announcement re-renders the `<Announcer>` and nothing
 * else. A board that re-rendered on every dice roll because a live region changed would be
 * paying for accessibility with frame rate, and that trade is never necessary.
 */

export type Politeness = "polite" | "assertive";

/** i18n params. Numbers and strings only — the catalogue interpolates, it does not format. */
export type AnnouncementParams = Readonly<Record<string, string | number>>;

export interface AnnouncementDraft {
  /**
   * Which region says it.
   *
   * `assertive` is reserved for the moments the *acting player changes* — a turn starting,
   * an interrupt taking over the table. Everything else is polite. Making the dice assertive
   * would interrupt whatever a screen reader user was in the middle of hearing, several
   * times a minute (GAP D1/D2).
   */
  readonly politeness: Politeness;
  /** An i18n key. Never a sentence: the engine speaks keys and so does this layer. */
  readonly key: string;
  readonly params: AnnouncementParams;
}

export interface Announcement extends AnnouncementDraft {
  /** Monotonic, bus-assigned. Two identical sentences are still two announcements. */
  readonly id: number;
}

export type AnnouncementListener = (added: readonly Announcement[]) => void;

export class AnnouncementBus {
  private nextId = 1;
  private readonly listeners = new Set<AnnouncementListener>();

  push(drafts: readonly AnnouncementDraft[]): readonly Announcement[] {
    if (drafts.length === 0) {
      return [];
    }
    const announcements = drafts.map((draft) => ({ ...draft, id: this.nextId++ }));
    for (const listener of [...this.listeners]) {
      listener(announcements);
    }
    return announcements;
  }

  subscribe(listener: AnnouncementListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
