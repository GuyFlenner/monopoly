import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { applyLocale, LOCALE_LABEL, LOCALES, type Locale } from "./i18n";

interface BoardSummary {
  id: string;
  name_key: string;
  tile_count: number;
  ownable_count: number;
}

/**
 * M0 placeholder shell.
 *
 * It exists to prove three things end to end before any game UI is built: the API is
 * reachable, the catalogues resolve, and switching to Hebrew mirrors the layout. The real
 * screens arrive at MON-403 onwards and will replace this entirely.
 *
 * Note there is not one physical CSS property below — `ms-*`, `gap` and `text-start` all
 * mirror themselves under `dir="rtl"`.
 */
export function App(): React.JSX.Element {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<Locale>("en");

  const boards = useQuery<BoardSummary[]>({
    queryKey: ["boards"],
    queryFn: async () => {
      const response = await fetch("/api/boards");
      if (!response.ok) {
        throw new Error(`/boards responded ${response.status}`);
      }
      return response.json() as Promise<BoardSummary[]>;
    },
  });

  function switchTo(next: Locale): void {
    setLocale(next);
    applyLocale(next);
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-start">
      <header className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-3xl font-bold">{t("app.title")}</h1>
        <p className="text-neutral-500">{t("app.tagline")}</p>
      </header>

      <fieldset className="flex items-center gap-3">
        <legend className="sr-only">{t("setup.language")}</legend>
        {LOCALES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={locale === candidate}
            onClick={() => switchTo(candidate)}
            className="min-h-11 rounded-lg border px-4 aria-pressed:font-bold"
          >
            {LOCALE_LABEL[candidate]}
          </button>
        ))}
      </fieldset>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{t("setup.board")}</h2>
        {boards.isPending && <p>…</p>}
        {boards.isError && <p role="alert">{t("error.gameNotFound")}</p>}
        <ul className="flex flex-col gap-2">
          {boards.data?.map((board) => (
            <li key={board.id} className="rounded-lg border p-3">
              <span className="font-medium">{t(board.name_key)}</span>{" "}
              <span dir="ltr" className="text-neutral-500">
                ({board.ownable_count})
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
