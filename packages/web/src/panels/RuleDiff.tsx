/**
 * What the chosen rule set changes, as the server marked it.
 *
 * Moved out of `SetupScreen.tsx` in MON-747 with the value renderer it calls, which is the only
 * caller it has. The decision this file carries is the second of the screen's three: the *server*
 * says which flags differ (`differs_from_universal` on `RuleFlagView`), and this renders them —
 * a client that worked out its own diff is one rename away from explaining the wrong rules.
 */

import { useTranslation } from "react-i18next";

import type { RuleFlagView, RuleValue } from "@/api";

/** What the chosen rule set changes, one row per flag the server marked. */
export function RuleDiff({
  differences,
}: {
  readonly differences: readonly RuleFlagView[];
}): React.JSX.Element {
  const { t } = useTranslation();
  if (differences.length === 0) {
    return <p className="text-ink-muted text-sm">{t("setup.kids_no_changes")}</p>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border-s-4 border-notice bg-current/5 p-3">
      <h3 className="text-ink-muted text-xs font-semibold uppercase tracking-[0.14em]">
        {t("setup.kids_changes")}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {differences.map((flag) => (
          <li key={flag.field} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{t(flag.label_key)}</span>
            <span className="font-semibold">{renderValue(flag.value, t)}</span>
            {/*
              "Full rules: N" rather than "was N → now M": an arrow is a direction, and a
              direction is the one thing that does not survive `dir="rtl"`.
            */}
            <span className="text-ink-muted text-xs">
              {t("ruleset.previous", { value: renderValue(flag.universal_value, t) })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

/**
 * One value as text. Presentation only — the classification is the server's `kind` tag.
 *
 * The `switch` is exhaustive over a discriminated union read off `generated.ts`, so a fifth kind
 * added to the contract is a compile error here rather than a blank cell.
 */
function renderValue(value: RuleValue, t: Translate): string {
  switch (value.kind) {
    case "flag":
      return t(value.on ? "ruleset.value.on" : "ruleset.value.off");
    case "number":
      return String(value.value);
    case "numbers":
      return value.values.join(", ");
    case "absent":
      return t("ruleset.value.none");
  }
}
