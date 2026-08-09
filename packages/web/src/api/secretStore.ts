/**
 * Where this browser keeps the credential that lets it speak for a seat (ADR-012, MON-906).
 *
 * A game is joined by *link*, so the only thing that distinguishes the person who started it from
 * the person who followed the link is a secret the server minted and handed over once. That secret
 * has to outlive a reload — a tablet reloads a backgrounded tab on its own, and a six-year-old
 * presses things — so it lives in `localStorage`, one slot per game.
 *
 * ## Every decision here is about not being trusted
 *
 * The discipline is ADR-010's, and deliberately the same one, because the failure mode is the same:
 * a browser in private mode throws on `setItem`, and a game that is working must not stop working
 * because it could not be written down. So every call is wrapped, every failure is swallowed, and
 * the worst case is a player who has to claim a seat again rather than a page that will not render.
 *
 * ## Why an interface rather than four `localStorage` calls in `client.ts`
 *
 * Because the store is the seam a test drives. A store that fails on write is the branch that
 * matters and the one a real browser only produces in private mode — and `ApiClient` takes its
 * `fetch` and its socket factory the same way, for the same reason.
 *
 * ## What is deliberately *not* here
 *
 * No expiry, no refresh, no recovery. A lost host secret is unrecoverable in v1 — the same class of
 * loss as a lost save file — and inventing a recovery path is a product decision the owner has not
 * made (ADR-012 §Open questions 2). Authority also dies with the API process, so a secret that
 * outlives a redeploy is simply a string the server no longer recognises; the holder becomes a
 * spectator and can claim a free seat again, which is the honest outcome and needs no code.
 */

/** The `kesef.secret.<gameId>` slot, as three functions that cannot throw. */
export interface SecretStore {
  get(gameId: string): string | undefined;
  set(gameId: string, secret: string): void;
  /** Forget this game's secret. Used when a game is left, so the slot cannot outlive its game. */
  clear(gameId: string): void;
}

/**
 * The storage key for one game.
 *
 * Namespaced like every other key this app writes, and **per game** rather than one shared slot:
 * a browser can hold two games at once (two tabs, one link each), and a single slot would hand the
 * second game's request the first game's credential — which resolves to Spectator and looks exactly
 * like "the server forgot me".
 */
export function secretKey(gameId: string): string {
  return `kesef.secret.${gameId}`;
}

/** Just enough of `Storage` to be substitutable in a test. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserSecretStore(storage?: StorageLike): SecretStore {
  const slot = (): StorageLike | null => {
    try {
      return storage ?? globalThis.localStorage;
    } catch {
      // Private mode throws on *access*, not only on write. Treated as "no storage at all".
      return null;
    }
  };
  return {
    get(gameId) {
      try {
        return slot()?.getItem(secretKey(gameId)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(gameId, secret) {
      try {
        slot()?.setItem(secretKey(gameId), secret);
      } catch {
        // A quota, or private mode. The game continues; only the ability to survive a reload as
        // this seat is lost, and re-claiming is a click.
      }
    },
    clear(gameId) {
      try {
        slot()?.removeItem(secretKey(gameId));
      } catch {
        // Nothing to do and nothing to report: the slot is already unreachable.
      }
    },
  };
}

/**
 * A store that keeps nothing, for a caller that has no browser storage to offer.
 *
 * The default inside `ApiClient` in a non-browser context, and what a test uses when the *storage*
 * is not the thing under test. Deliberately not "throw if used": a client with nowhere to keep a
 * secret is a spectator, which is a working state.
 */
export function memorySecretStore(): SecretStore {
  const held = new Map<string, string>();
  return {
    get: (gameId) => held.get(gameId),
    set: (gameId, secret) => {
      held.set(gameId, secret);
    },
    clear: (gameId) => {
      held.delete(gameId);
    },
  };
}
