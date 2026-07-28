/**
 * The language switch, as one button per language.
 *
 * A button group rather than a `<select>`: there are two languages, both are one short word, and a
 * six-year-old can hit a button but has to be taught a dropdown. `aria-pressed` carries the state,
 * so a screen reader says "English, pressed" rather than requiring the visual weight to mean
 * something.
 *
 * **Each language is labelled in itself** — "English" and "עברית", never "Hebrew". Somebody who
 * needs to switch *to* Hebrew is, by definition, the person least able to read the English word for
 * it. `LOCALE_LABEL` holds those endonyms, which is why they are not catalogue keys: they must not
 * change when the page language does.
 *
 * The group is `dir="ltr"`-free and uses logical properties throughout, so it reverses with the
 * page like any other chrome. Unlike the board, there is nothing here whose meaning depends on
 * which side it starts from.
 */

import { useTranslation } from "react-i18next";

import { LOCALES, LOCALE_LABEL } from ".";
import { useLocale } from "./useLocale";

export interface LocaleSwitchProps {
  readonly className?: string;
}

export function LocaleSwitch({ className }: LocaleSwitchProps): React.JSX.Element {
  const { t } = useTranslation();
  const [locale, setLocale] = useLocale();

  return (
    <div
      role="group"
      aria-label={t("label.language")}
      data-testid="locale-switch"
      className={`border-hairline bg-tile flex items-center gap-1 rounded-xl border p-1 ${className ?? ""}`}
    >
      {LOCALES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          lang={candidate}
          aria-pressed={candidate === locale}
          data-testid={`locale-${candidate}`}
          onClick={() => {
            setLocale(candidate);
          }}
          className="target text-ink rounded-lg px-3 py-2 text-sm font-semibold aria-pressed:bg-[color-mix(in_oklab,currentColor_12%,transparent)] aria-pressed:font-bold"
        >
          {LOCALE_LABEL[candidate]}
        </button>
      ))}
    </div>
  );
}
