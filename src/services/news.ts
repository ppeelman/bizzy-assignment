import normalizeUrl from "normalize-url";
import Parser from "rss-parser";
import type { FetchedDoc } from "../core/types";
import { type FetchOpts, fetchWithTimeout } from "./http";
import { type Logger, silentLogger } from "./logger";

interface GNewsItem {
  title: string;
  url: string;
  publishedAt?: string;
  source?: string;
}

export interface NewsClientConfig {
  tavilyApiKey?: string;
  logger?: Logger;
}

export class NewsClient {
  private readonly rss = new Parser<unknown, { source?: string }>({
    customFields: { item: ["source"] },
  });
  private readonly log: Logger;

  constructor(private readonly config: NewsClientConfig = {}) {
    this.log = config.logger ?? silentLogger;
  }

  async fetchTavily(companyName: string, opts: FetchOpts = {}): Promise<FetchedDoc[]> {
    const apiKey = this.config.tavilyApiKey;
    if (!apiKey) {
      this.log.debug("Tavily skipped: no API key");
      return [];
    }

    const res = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${companyName} company news`,
        topic: "news",
        max_results: 5,
        include_answer: false,
      }),
      timeoutMs: opts.timeoutMs ?? 8000,
      signal: opts.signal,
    });
    if (!res.ok) {
      this.log.warn({ status: res.status, companyName }, "Tavily non-2xx");
      throw new Error(`tavily_status_${res.status}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    };
    const docs = (data.results ?? [])
      .filter((r) => r.url && (r.content || r.title))
      .slice(0, 5)
      .map((r) => ({
        type: "tavily_news" as const,
        source_url: r.url!,
        text: [r.title, r.published_date, r.content].filter(Boolean).join(" — ").slice(0, 2000),
        fetcher: "tavily" as const,
      }));
    this.log.debug({ companyName, count: docs.length }, "tavily results");
    return docs;
  }

  async fetchGoogleNews(
    companyName: string,
    hostname: string,
    opts: FetchOpts = {},
  ): Promise<FetchedDoc[]> {
    const locales = this.localeFromTld(hostname);
    const all: GNewsItem[] = [];

    await Promise.all(
      locales.map(async ({ hl, gl }) => {
        const q = encodeURIComponent(`"${companyName}"`);
        const url = `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;
        try {
          const res = await fetchWithTimeout(url, {
            timeoutMs: opts.timeoutMs ?? 6000,
            signal: opts.signal,
          });
          if (!res.ok) {
            this.log.warn({ status: res.status, hl, gl }, "gnews non-2xx");
            return;
          }
          const feed = await this.rss.parseString(await res.text());
          for (const item of feed.items.slice(0, 5)) {
            const title = item.title?.trim();
            const link = item.link?.trim();
            if (!title || !link) continue;
            all.push({
              title,
              url: link,
              publishedAt: item.isoDate,
              source: typeof item.source === "string" ? item.source : undefined,
            });
          }
        } catch (e) {
          this.log.warn(
            { hl, gl, err: e instanceof Error ? e.message : String(e) },
            "gnews parse failed",
          );
        }
      }),
    );

    const resolved = await Promise.all(
      all.map(async (item) => ({
        ...item,
        url: await this.resolveRedirect(item.url, opts.signal),
      })),
    );

    const out = this.dedupAndShape(resolved);
    this.log.debug({ companyName, count: out.length, locales: locales.length }, "gnews results");
    return out;
  }

  private localeFromTld(hostname: string): Array<{ hl: string; gl: string }> {
    const tld = hostname.split(".").pop()?.toLowerCase() ?? "";
    const base = [{ hl: "en-US", gl: "US" }];
    switch (tld) {
      case "be":
        return [{ hl: "nl-BE", gl: "BE" }, { hl: "fr-BE", gl: "BE" }, ...base];
      case "fr":
        return [{ hl: "fr-FR", gl: "FR" }, ...base];
      case "de":
        return [{ hl: "de-DE", gl: "DE" }, ...base];
      case "nl":
        return [{ hl: "nl-NL", gl: "NL" }, ...base];
      case "it":
        return [{ hl: "it-IT", gl: "IT" }, ...base];
      case "es":
        return [{ hl: "es-ES", gl: "ES" }, ...base];
      default:
        return base;
    }
  }

  private async resolveRedirect(googleUrl: string, signal?: AbortSignal): Promise<string> {
    try {
      const res = await fetchWithTimeout(googleUrl, {
        redirect: "manual",
        timeoutMs: 4000,
        signal,
      });
      const loc = res.headers.get("location");
      return loc ?? googleUrl;
    } catch {
      return googleUrl;
    }
  }

  private dedupAndShape(items: GNewsItem[]): FetchedDoc[] {
    const seen = new Set<string>();
    const deduped: GNewsItem[] = [];
    for (const item of items.sort((a, b) =>
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
    )) {
      let key: string;
      try {
        key = normalizeUrl(item.url, {
          stripWWW: true,
          stripHash: true,
          removeTrailingSlash: true,
          removeQueryParameters: [/^utm_/i],
        });
      } catch {
        key = item.url;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
      if (deduped.length >= 6) break;
    }

    return deduped.map((item) => ({
      type: "gnews" as const,
      source_url: item.url,
      text: `${item.title} — ${item.source ?? ""} — ${item.publishedAt ?? ""}`.trim(),
      fetcher: "gnews" as const,
    }));
  }
}
