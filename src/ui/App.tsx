import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { EnrichmentResponse, ErrorResponse } from "../core/types";
import { ErrorCard } from "./components/ErrorCard";
import { Gate } from "./components/Gate";
import { ResultCard } from "./components/ResultCard";
import { Skeleton } from "./components/Skeleton";

const DEMO_KEY_STORAGE = "bizzy-demo-key";

type ResultState =
  | { kind: "idle" }
  | { kind: "loading"; url: string }
  | { kind: "ok"; data: EnrichmentResponse }
  | { kind: "err"; error: ErrorResponse; status: number };

export function App() {
  const { t } = useTranslation();
  const [demoKey, setDemoKey] = useState<string | null>(() =>
    localStorage.getItem(DEMO_KEY_STORAGE),
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [url, setUrl] = useState("");
  const [state, setState] = useState<ResultState>({ kind: "idle" });
  const [slowHint, setSlowHint] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : { authRequired: false }))
      .then((cfg: { authRequired?: boolean }) => setAuthRequired(Boolean(cfg.authRequired)))
      .catch(() => setAuthRequired(false));
  }, []);

  useEffect(() => {
    if (state.kind !== "loading") {
      setSlowHint(false);
      return;
    }
    const timer = setTimeout(() => setSlowHint(true), 15000);
    return () => clearTimeout(timer);
  }, [state.kind]);

  async function enrich(target: string) {
    setState({ kind: "loading", url: target });
    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(demoKey ? { "X-Demo-Key": demoKey } : {}),
        },
        body: JSON.stringify({ url: target }),
      });
      if (res.status === 401) {
        localStorage.removeItem(DEMO_KEY_STORAGE);
        setDemoKey(null);
        return;
      }
      const body = (await res.json()) as EnrichmentResponse | ErrorResponse;
      if (!res.ok) {
        setState({ kind: "err", error: body as ErrorResponse, status: res.status });
      } else {
        setState({ kind: "ok", data: body as EnrichmentResponse });
      }
    } catch (e) {
      setState({
        kind: "err",
        error: { error: "internal_error", reason: e instanceof Error ? e.message : String(e) },
        status: 0,
      });
    }
  }

  function handleUnlock(k: string) {
    localStorage.setItem(DEMO_KEY_STORAGE, k);
    setDemoKey(k);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind === "loading") return;
    const v = url.trim();
    if (!v) return;
    const normalized = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    void enrich(normalized);
  }

  function handleUrlChange(e: ChangeEvent<HTMLInputElement>) {
    setUrl(e.target.value);
  }

  function handleStripeDemo() {
    setUrl("https://stripe.com");
    void enrich("https://stripe.com");
  }

  if (authRequired && !demoKey) {
    return <Gate onUnlock={handleUnlock} />;
  }

  const isRateLimited = state.kind === "err" && state.error.error === "rate_limited";

  return (
    <div className="app">
      <header className="header">
        <div className="header__title">{t("header.title")}</div>
        <div className="header__pill">{t("header.pill")}</div>
      </header>

      <main>
        <search className="input-bar">
          <form className="input-bar__form" onSubmit={handleSubmit}>
            <label
              htmlFor="url-input"
              className="visually-hidden"
              style={{ position: "absolute", left: -10000 }}
            >
              {t("input.label")}
            </label>
            <input
              id="url-input"
              className="text-input"
              type="text"
              placeholder={t("input.placeholder")}
              value={url}
              onChange={handleUrlChange}
              // biome-ignore lint/a11y/noAutofocus: intentional UX — primary action input on app load
              autoFocus
              spellCheck={false}
            />
            <button
              type="submit"
              className="button button--accent"
              disabled={state.kind === "loading"}
            >
              {state.kind === "loading" ? t("input.submitting") : t("input.submit")}
            </button>
          </form>
        </search>

        {isRateLimited ? (
          <aside className="banner banner--rate" role="status">
            {t("error.rateLimit")}
          </aside>
        ) : null}

        {state.kind === "loading" ? (
          <>
            <Skeleton />
            {slowHint ? (
              <p
                className="empty-note"
                role="status"
                style={{ textAlign: "center", marginTop: 12 }}
              >
                {t("loading.slow")}
              </p>
            ) : null}
          </>
        ) : null}

        {state.kind === "ok" ? <ResultCard data={state.data} /> : null}
        {state.kind === "err" && !isRateLimited ? <ErrorCard error={state.error} /> : null}

        {state.kind === "idle" ? (
          <section
            className="card"
            style={{ background: "transparent", border: "1px dashed var(--rule)" }}
          >
            <p style={{ color: "var(--ink-muted)", fontSize: 14 }}>
              <Trans
                i18nKey="idle.hint"
                components={[
                  <button
                    type="button"
                    key="0"
                    onClick={handleStripeDemo}
                    style={{
                      background: "transparent",
                      border: 0,
                      color: "var(--accent)",
                      cursor: "pointer",
                      padding: 0,
                      font: "inherit",
                      textDecoration: "underline",
                    }}
                  />,
                ]}
              />
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
