import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src/api/generated.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // Right-to-left correctness, enforced rather than reviewed. A physical CSS property
      // is invisible in English and obviously broken in Hebrew, which is the worst kind of
      // bug to leave to human vigilance. See ADR-003 and MON-502.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/\\b(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-/]",
          message:
            "Use logical properties (ms/me, ps/pe, start/end, text-start/text-end) so the layout mirrors in Hebrew.",
        },
      ],
    },
  },
);
