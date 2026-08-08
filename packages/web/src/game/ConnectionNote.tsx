/**
 * The one sentence about the transport, and — since MON-908 — the *specific* one.
 *
 * A closed socket had five causes and one sentence: "Not connected to the table", whether the
 * game had been deleted, the watcher cap was full, or the handshake was refused. Three of those
 * are answerable ("this game no longer exists" is a reason to start a new one, "too many people
 * are watching" is a reason to wait) and the collapsed line answered none of them.
 *
 * `status.offline` stays as the fallback and is still what most closes get: a dropped network
 * closes with 1006, which is exactly the case where the honest sentence is the vague one.
 * `closeReasonKey` decides, off the code, and returns `undefined` when it has nothing to add.
 *
 * A sibling of `GameScreen.tsx` since MON-747, where it was the status half of a thousand-line
 * file. It renders `null` rather than nothing-in-a-wrapper when the socket is healthy, which is
 * what keeps the caller a single element instead of a conditional — and it is deliberately **not**
 * a live region: `<Announcer>` at the root owns both of those (GAP D1/G-54), and a note that
 * appears above a board that has not moved is a thing to read, not a thing to interrupt for.
 */

import { useTranslation } from "react-i18next";

import { closeReasonKey, type ConnectionStatus } from "@/api";

/** The key this connection state is described by, or `null` when there is nothing to say. */
export function connectionNoteKey(connection: ConnectionStatus): string | null {
  return connection.state === "reconnecting"
    ? "status.reconnecting"
    : connection.state === "closed"
      ? (closeReasonKey(connection.closeCode) ?? "status.offline")
      : null;
}

export function ConnectionNote({
  connection,
}: {
  readonly connection: ConnectionStatus;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const key = connectionNoteKey(connection);
  return key === null ? null : (
    <p data-testid="connection-note" className="text-sm opacity-80">
      {t(key)}
    </p>
  );
}
