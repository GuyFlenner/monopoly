/// <reference types="vite/client" />

/**
 * The build-time switches this app reads, declared so they are typed rather than `any`.
 *
 * `vite/client` gives `ImportMetaEnv` an `[key: string]: any` index signature, which under
 * `strictTypeChecked` makes every `import.meta.env.VITE_*` read an unsafe member access. Declared
 * members win over the index signature, so naming them here is what keeps the lint honest.
 */
interface ImportMetaEnv {
  /**
   * `"local"` runs the Python rules engine in the browser under Pyodide, with no server at all
   * (MON-805). Anything else — including unset, which is the default — talks to the HTTP API.
   */
  readonly VITE_ENGINE?: string;
  /**
   * The Pyodide release to load, overriding {@link PYODIDE_VERSION}. It must ship CPython 3.13 or
   * newer, because both wheels declare `requires-python = ">=3.13"` and micropip enforces it.
   */
  readonly VITE_PYODIDE_VERSION?: string;
}
