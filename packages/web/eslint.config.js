import { readFileSync } from "node:fs";
import { URL } from "node:url";

import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// The RTL selectors live in JSON so that this config and the Vitest test which proves they
// actually fire (src/theme/logical-css.test.ts) read the same bytes. A lint rule nobody has
// watched fail is a lint rule nobody knows works.
const logicalCss = JSON.parse(
  readFileSync(new URL("./eslint.logical-css.json", import.meta.url), "utf8"),
);

export default tseslint.config(
  { ignores: ["dist", "src/api/generated.ts"] },
  js.configs.recommended,
  {
    // Type-aware rules need `parserOptions.project`, which only covers the files in
    // tsconfig.json's `include`. Scoping the whole type-checked preset to ts/tsx here
    // (rather than spreading it top-level) keeps eslint.config.js itself lintable as
    // plain JS instead of erroring for lack of type information.
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // See eslint.logical-css.json for what these catch and why (ADR-003, MON-502, GAP §3
      // G-45). CSS files are covered separately by Stylelint, which `npm run lint` runs
      // alongside this — ESLint does not parse CSS at all, so a `margin-left` in index.css
      // used to pass in silence.
      "no-restricted-syntax": ["error", ...logicalCss.restrictions],
    },
  },
);
