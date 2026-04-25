import type { FetchedDoc, SourceFailure } from "../core/types";
import type { SourceProvider, SourcesResult } from "../enrich";
import { type Logger, silentLogger } from "./logger";
import type { NewsClient } from "./news";
import type { Scraper } from "./scrapers";
import { assertSafeUrl, SsrfError } from "./ssrf";

export class SourcesService implements SourceProvider {
  private readonly log: Logger;

  constructor(
    private readonly scraper: Scraper,
    private readonly news: NewsClient,
    logger?: Logger,
  ) {
    this.log = logger ?? silentLogger;
  }

  async fetchSources(rawUrl: string, signal?: AbortSignal): Promise<SourcesResult> {
    let safeUrl: URL;
    try {
      safeUrl = await assertSafeUrl(rawUrl);
    } catch (err) {
      const reason = err instanceof SsrfError ? err.code : "invalid_url";
      this.log.warn({ rawUrl, reason }, "SSRF guard rejected URL");
      return { ok: false, code: "ssrf_rejected", reason, failures: [] };
    }

    const failures: SourceFailure[] = [];
    const homepage = await this.scraper.fetchHomepage(safeUrl, { signal }).catch((e) => {
      failures.push({ type: "homepage", source_url: safeUrl.toString(), error: errMsg(e) });
      return null;
    });

    if (!homepage || homepage.text.length < 100) {
      failures.push({
        type: "homepage",
        source_url: safeUrl.toString(),
        error: homepage ? "thin_content" : "fetch_failed",
      });
      this.log.warn({ url: safeUrl.toString() }, "homepage unavailable, aborting enrichment");
      return { ok: false, code: "source_fetch_failed", reason: "homepage_unavailable", failures };
    }

    const homeDoc: FetchedDoc = {
      type: "homepage",
      source_url: homepage.url.toString(),
      text: homepage.text.slice(0, 10000),
      fetcher: homepage.fetcher,
    };

    const [linkedPages, tavily, gnews] = await Promise.all([
      this.scraper.fetchLinkedPages(homepage.url, homepage.$, { signal }).catch((e) => {
        failures.push({ type: "linked_pages", error: errMsg(e) });
        return [] as FetchedDoc[];
      }),
      this.news.fetchTavily(homepage.companyName, { signal }).catch((e) => {
        failures.push({ type: "tavily", error: errMsg(e) });
        return [] as FetchedDoc[];
      }),
      this.news
        .fetchGoogleNews(homepage.companyName, homepage.url.hostname, { signal })
        .catch((e) => {
          failures.push({ type: "gnews", error: errMsg(e) });
          return [] as FetchedDoc[];
        }),
    ]);

    this.log.info(
      {
        company: homepage.companyName,
        homepage: homepage.url.toString(),
        homepage_fetcher: homepage.fetcher,
        linked: linkedPages.length,
        tavily: tavily.length,
        gnews: gnews.length,
        failures: failures.length,
      },
      "source bundle ready",
    );

    return {
      ok: true,
      bundle: {
        homepageUrl: homepage.url.toString(),
        companyName: homepage.companyName,
        docs: [homeDoc, ...linkedPages, ...tavily, ...gnews],
        failures,
      },
    };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
