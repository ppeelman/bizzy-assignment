import { useTranslation } from "react-i18next";
import type { EnrichmentResponse } from "../../core/types";
import { hostnameOf } from "../utils";
import { Confidence } from "./Confidence";

export function ResultCard({ data }: { data: EnrichmentResponse }) {
  const { t } = useTranslation();
  const homepageUrl = data._debug.fetched_sources.find((s) => s.type === "homepage")?.source_url;
  const titleHost = homepageUrl ? hostnameOf(homepageUrl).split(".")[0] : "";
  const displayName = titleHost
    ? titleHost.charAt(0).toUpperCase() + titleHost.slice(1)
    : t("result.fallbackName");

  return (
    <article className="card">
      <h1 className="h1">{displayName}</h1>
      {data.industry.value ? (
        <p>
          <span className="industry">{data.industry.value}</span>
          <Confidence field={data.industry} />
        </p>
      ) : null}

      {data.summary.value ? (
        <>
          <p className="summary">{data.summary.value}</p>
          <Confidence field={data.summary} />
        </>
      ) : (
        <p className="summary empty-note">{t("result.noSummary")}</p>
      )}

      {data.reasons.length > 0 ? (
        <section aria-labelledby="reasons-h">
          <h2 id="reasons-h" className="section-label">
            {t("result.whyReachOut")}
          </h2>
          <ol className="reasons">
            {data.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
          <span className="conf conf--inferred">
            <span className="conf__dot" aria-hidden="true" />
            <span className="conf__label">{t("result.inferred")}</span>
          </span>
        </section>
      ) : null}

      <div className="two-col">
        <section className="subcard" aria-labelledby="contacts-h">
          <h2 id="contacts-h" className="subcard__heading">
            {t("result.contacts.title", { count: data.contacts.length })}
          </h2>
          {data.contacts.length === 0 ? (
            <p className="empty-note">{t("result.contacts.empty")}</p>
          ) : (
            <ul className="contact-list">
              {data.contacts.map((c) => (
                <li key={`${c.name.value}-${c.role.value ?? ""}`} className="contact">
                  <div className="contact__name">{c.name.value}</div>
                  <div className="contact__role">{c.role.value ?? t("result.contacts.noRole")}</div>
                  {c.why ? <p className="contact__why">{c.why}</p> : null}
                  <Confidence field={c.name} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="subcard" aria-labelledby="news-h">
          <h2 id="news-h" className="subcard__heading">
            {t("result.news.title", { count: data.news.length })}
          </h2>
          {data.news.length === 0 ? (
            <p className="empty-note">{t("result.news.empty")}</p>
          ) : (
            <ul className="news-list">
              {data.news.map((n) => (
                <li key={n.url}>
                  <article className="news">
                    <h3 className="news__title">
                      <a href={n.url} target="_blank" rel="noopener noreferrer">
                        {n.title.value}
                      </a>
                    </h3>
                    <p className="news__meta">
                      {hostnameOf(n.url)}
                      {n.date ? ` · ${new Date(n.date).toLocaleDateString()}` : ""}
                    </p>
                    <Confidence field={n.title} />
                  </article>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer
        style={{
          marginTop: 24,
          paddingTop: 16,
          borderTop: "1px solid var(--rule)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--ink-faint)",
        }}
      >
        {t("result.debug.summary", {
          sources: data._debug.fetched_sources.length,
          citations: data._debug.citations_count,
          elapsed: (data._debug.elapsed_ms / 1000).toFixed(1),
          model: data._debug.model,
        })}
        {data._debug.failures.length > 0
          ? t("result.debug.failures", { count: data._debug.failures.length })
          : ""}
      </footer>
    </article>
  );
}
