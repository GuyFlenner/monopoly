/**
 * Which transport this build uses. Deliberately a file with no imports.
 *
 * `main.tsx` reads this to decide whether to `import("./local")` at all, so the local transport —
 * the route table, the fake socket, the Pyodide loader — is a chunk the server build never fetches.
 * If the check lived in `local/index.ts`, importing it in order to ask the question would already
 * have pulled in everything it answers about.
 */

/** The value `VITE_ENGINE` must have for the rules engine to run in the browser (MON-805). */
export const LOCAL_ENGINE = "local";

export function isLocalEngineBuild(
  mode: string | undefined = import.meta.env.VITE_ENGINE,
): boolean {
  return mode === LOCAL_ENGINE;
}
