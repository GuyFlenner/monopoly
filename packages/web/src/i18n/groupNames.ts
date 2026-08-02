/**
 * What a colour group is *called* on the board being played.
 *
 * ## The defect this exists to fix
 *
 * On the classic board a colour group is a colour: the two brown squares are "the brown set" and
 * nothing else names them. On the Israeli board a colour group is a **city**, and its squares are
 * streets in that city — Allenby and Dizengoff are Tel Aviv, Jaffa and Ben Yehuda and King George
 * are Jerusalem. Labelling that band "dark blue" is not merely bland, it is wrong in the way a
 * mistranslation is wrong: it names a property of the ink instead of the thing on the board, and a
 * player holding both Tel Aviv streets is told they own "dark blue".
 *
 * ## Why a catalogue key rather than a table
 *
 * Boards already own an i18n namespace — a tile's name resolves as `t(name_key, {ns: "board-israel"})`,
 * which is what lets board choice and language vary independently (see `i18n/index.ts`). A group's
 * name is the same kind of fact as a square's name, so it lives in the same place: `group.dark_blue`
 * in `board-israel.he.json` beside `tile.israel.t37`. Nothing in the engine changes, nothing on the
 * wire changes, and the Hebrew build stays a catalogue rather than a code change.
 *
 * A board that has no opinion — the classic one — simply defines no `group.*` entries, and the
 * global `common` catalogue's colour names answer instead. That fallback is the whole mechanism, and
 * it has to be a guarded lookup rather than an i18next `fallbackNS`: `missingKeyHandler` throws
 * under dev and test by design (GAP G-F17), so asking for `board-classic:group.dark_blue` and
 * catching nothing would take the panel down. `exists` first, then translate — the same guarded
 * lookup the event log, the action bar and the dossier already use for board-scoped square names.
 *
 * ## One resolver, and why it is total over keys
 *
 * {@link groupLabel} accepts *any* catalogue key and only board-scopes the ones under `group.`.
 * That is deliberate: it lets the generic `*_key` param resolver in `panels/EventLogLines.ts` route
 * every key it meets through here without learning what a colour group is, which was the point of
 * MON-415. A group name reaching a screen through a path that does not call this function is the
 * bug this module is for — "dark blue" beside "Tel Aviv" on the same screen — so the render sites
 * are pinned by a source scan in `groupNames.test.ts` rather than by care.
 *
 * Kids Mode needs nothing here and gets it for free: `kidsKey` refuses to twin a namespaced key
 * (`i18n/copy.ts`), so `board-israel:group.dark_blue` is handed straight through. A city is a proper
 * noun; there is no simpler word for Tel Aviv.
 */

/**
 * A translate function.
 *
 * Structurally `board/projection.ts`'s `Translate` and `i18n/copy.ts`'s `Copy`, so a screen can hand
 * in whichever it already has — including `useCopy(kids)`'s, so the wording matches the column
 * beside it.
 */
export type TranslateKey = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * Everything {@link groupLabel} needs, as one value a component builds once and passes down.
 *
 * All three fields are required on purpose. A render site that forgets the board is a site that
 * prints the colour beside a sibling printing the city, and the only way to make that a compile
 * error rather than a screenshot is to refuse to default any of them.
 */
export interface GroupNameScope {
  /** `board.id` — `"classic"`, `"israel"`. `undefined` until the first view arrives. */
  readonly boardId: string | undefined;
  /** The screen's translate, so a group's name is worded like everything around it. */
  readonly translate: TranslateKey;
  /**
   * `i18n.exists`, bound.
   *
   * The guard, not an optimisation: the classic board defines no `group.*` entry and must not throw
   * for asking. See the module docstring.
   */
  readonly exists: (key: string) => boolean;
}

/** The prefix every colour-group name key carries, in `common` and in a board catalogue alike. */
export const GROUP_KEY_PREFIX = "group.";

/**
 * True for a key a board may rename: `group.dark_blue`, `group.railroad`.
 *
 * A key that already names a namespace (`board-israel:group.dark_blue`) is excluded, because
 * scoping it twice would produce `board-israel:board-israel:…` — i18next reads the first colon as
 * the separator, so the result would be a namespace nobody registered.
 */
export function isGroupKey(key: string): boolean {
  return key.startsWith(GROUP_KEY_PREFIX) && !key.includes(":");
}

/**
 * The board-scoped twin of a group key, or `null` when there cannot be one.
 *
 * `null` for a key that is not a group name, and for a screen with no board yet. Exported so a test
 * can name the key it expects rather than re-deriving the string format.
 */
export function boardGroupKey(key: string, boardId: string | undefined): string | null {
  return boardId === undefined || !isGroupKey(key) ? null : `board-${boardId}:${key}`;
}

/**
 * Translate a name key, letting the board being played name its own colour groups.
 *
 * `group.dark_blue` on the Israeli board is "תל אביב" / "Tel Aviv"; on the classic board, and on any
 * board whose catalogue is silent, it is the colour. **Every other key resolves exactly as
 * `scope.translate` would** — which is what lets the one generic `*_key` resolver call this for all
 * of its params with no branch, and what keeps this function safe to reach for anywhere a name key
 * is rendered.
 */
export function groupLabel(scope: GroupNameScope, key: string): string {
  const scoped = boardGroupKey(key, scope.boardId);
  return scoped !== null && scope.exists(scoped) ? scope.translate(scoped) : scope.translate(key);
}
