import { useState } from "react";
import { useTranslation } from "react-i18next";

export function Gate({ onUnlock }: { onUnlock: (key: string) => void }) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="gate">
      <section className="gate__card">
        <h1>{t("gate.title")}</h1>
        <p>{t("gate.description")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = (e.currentTarget.elements.namedItem("key") as HTMLInputElement).value.trim();
            if (!v) {
              setErr(t("gate.errors.empty"));
              return;
            }
            onUnlock(v);
          }}
        >
          <label htmlFor="key" style={{ fontSize: 13, color: "var(--ink-muted)" }}>
            {t("gate.label")}
          </label>
          <input
            id="key"
            name="key"
            type="password"
            // biome-ignore lint/a11y/noAutofocus: intentional UX — first input on a single-purpose gate
            autoFocus
            required
            className="text-input"
            onChange={() => setErr(null)}
          />
          <button type="submit" className="button button--accent">
            {t("gate.submit")}
          </button>
          {err ? (
            <p className="gate__error" role="alert">
              {err}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}
