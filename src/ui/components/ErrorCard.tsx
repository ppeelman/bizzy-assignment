import { useTranslation } from "react-i18next";
import type { ErrorResponse } from "../../core/types";

export function ErrorCard({ error }: { error: ErrorResponse }) {
  const { t } = useTranslation();
  return (
    <section className="card banner banner--error" role="alert">
      <strong>{t("error.title")}</strong>
      <p style={{ marginTop: 6, fontSize: 14 }}>
        {error.error}
        {error.reason ? ` — ${error.reason}` : ""}
      </p>
      {error.failures && error.failures.length > 0 ? (
        <ul style={{ marginTop: 8, fontSize: 13, paddingLeft: 18 }}>
          {error.failures.map((f) => (
            <li key={`${f.type}:${f.error}`}>
              {f.type}: {f.error}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
