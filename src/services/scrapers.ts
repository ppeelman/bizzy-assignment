import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import metascraper from "metascraper";
import metascraperPublisher from "metascraper-publisher";
import metascraperTitle from "metascraper-title";
import { getDomain } from "tldts";
import type { FetchedDoc } from "../core/types";
import { type FetchOpts, fetchWithTimeout } from "./http";
import { type Logger, silentLogger } from "./logger";
import { assertSafeUrl } from "./ssrf";

const MAX_REDIRECTS = 5;

function sameSite(a: string, b: string): boolean {
  const da = getDomain(a);
  const db = getDomain(b);
  return da !== null && da === db;
}

export interface HomepageResult {
  url: URL;
  text: string;
  $: CheerioAPI;
  fetcher: "cheerio" | "cloudflare";
  companyName: string;
}

interface PageContent {
  url: URL;
  text: string;
  html: string;
  $: CheerioAPI;
}

export interface ScraperConfig {
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  logger?: Logger;
}

const meta = metascraper([metascraperPublisher(), metascraperTitle()]);

export class Scraper {
  private static readonly LINKED_PATTERNS =
    /(about|team|company|people|leadership|contact|who-we-are)/i;

  private readonly log: Logger;

  constructor(private readonly config: ScraperConfig = {}) {
    this.log = config.logger ?? silentLogger;
  }

  async fetchHomepage(url: URL, opts: FetchOpts = {}): Promise<HomepageResult | null> {
    const cheerioResult = await this.fetchWithCheerio(url, opts).catch((e) => {
      this.log.warn({ url: url.toString(), err: errMsg(e) }, "cheerio fetch failed");
      return null;
    });
    if (cheerioResult && cheerioResult.text.length >= 200) {
      this.log.debug(
        { url: cheerioResult.url.toString(), bytes: cheerioResult.text.length },
        "homepage via cheerio",
      );
      return this.toHomepage(cheerioResult, "cheerio");
    }

    if (this.config.cloudflareApiToken && this.config.cloudflareAccountId) {
      this.log.info(
        { url: url.toString(), reason: cheerioResult ? "thin_content" : "fetch_failed" },
        "falling back to Cloudflare Browser Run",
      );
      const cf = await this.fetchCloudflareCrawl(url, {
        ...opts,
        timeoutMs: opts.timeoutMs ?? 15000,
      }).catch((e) => {
        this.log.warn({ url: url.toString(), err: errMsg(e) }, "cloudflare fetch failed");
        return null;
      });
      if (cf && cf.text.length >= 200) {
        this.log.debug(
          { url: cf.url.toString(), bytes: cf.text.length },
          "homepage via cloudflare",
        );
        return this.toHomepage(cf, "cloudflare");
      }
    }

    if (!cheerioResult) {
      this.log.warn({ url: url.toString() }, "homepage fetch yielded nothing");
    }
    return cheerioResult ? this.toHomepage(cheerioResult, "cheerio") : null;
  }

  async fetchLinkedPages(baseUrl: URL, $: CheerioAPI, opts: FetchOpts = {}): Promise<FetchedDoc[]> {
    const candidates = new Set<string>();
    $("a[href]").each((_i, el) => {
      const raw = $(el).attr("href")?.trim();
      const text = $(el).text().trim();
      if (!raw) return;
      if (raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return;
      if (!(Scraper.LINKED_PATTERNS.test(raw) || Scraper.LINKED_PATTERNS.test(text))) return;
      try {
        const u = new URL(raw, baseUrl);
        if (!sameSite(baseUrl.toString(), u.toString())) return;
        candidates.add(u.toString().split("#")[0]!);
      } catch {
        /* ignore malformed */
      }
    });

    const top = [...candidates].slice(0, 3);
    const docs = await Promise.all(
      top.map(async (href): Promise<FetchedDoc | null> => {
        try {
          const u = new URL(href);
          const fetched = await this.fetchWithCheerio(u, { ...opts, timeoutMs: 5000 });
          if (!fetched || fetched.text.length < 100) return null;
          const type: FetchedDoc["type"] = /team|people|leadership/i.test(href) ? "team" : "about";
          return {
            type,
            source_url: fetched.url.toString(),
            text: fetched.text.slice(0, 8000),
            fetcher: "cheerio",
          };
        } catch {
          return null;
        }
      }),
    );
    return docs.filter((d): d is FetchedDoc => d !== null);
  }

  private async toHomepage(
    page: PageContent,
    fetcher: "cheerio" | "cloudflare",
  ): Promise<HomepageResult> {
    return {
      url: page.url,
      text: page.text,
      $: page.$,
      fetcher,
      companyName: await this.extractCompanyName(page),
    };
  }

  private async extractCompanyName(page: PageContent): Promise<string> {
    try {
      const result = await meta({ html: page.html, url: page.url.toString() });
      const publisher = result.publisher?.trim();
      if (publisher) return publisher;
      const title = result.title?.trim();
      if (title) {
        const head = title.split(/[|·–—-]/)[0]?.trim();
        if (head && head.length > 1 && head.length < 80) return head;
      }
    } catch {
      /* fall through to domain root */
    }
    const host = page.url.hostname.replace(/^www\./, "");
    const root = host.split(".")[0] ?? host;
    return root
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  private extractMainText($: CheerioAPI): string {
    $("script, style, noscript, iframe, svg, nav, footer, header").remove();
    const main = $("main").text() || $("article").text() || $("body").text();
    return main.replace(/\s+/g, " ").trim();
  }

  /**
   * Chase redirects manually so each Location can be re-validated by assertSafeUrl
   * before we follow it. Bun's default `redirect: "follow"` would let an attacker
   * redirect us into private IPs (TOCTOU between the initial DNS check and the
   * actual fetch).
   */
  private async fetchWithCheerio(url: URL, opts: FetchOpts): Promise<PageContent | null> {
    let current = url;
    const inputUrl = url.toString();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchWithTimeout(current.toString(), {
        ...opts,
        timeoutMs: opts.timeoutMs ?? 5000,
        redirect: "manual",
      });

      // Redirect — re-validate the next hop before following.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          this.log.warn(
            { url: current.toString(), status: res.status },
            "redirect with no Location header",
          );
          return null;
        }
        const next = new URL(loc, current);
        try {
          await assertSafeUrl(next.toString());
        } catch (e) {
          this.log.warn(
            {
              from: current.toString(),
              to: next.toString(),
              reason: e instanceof Error ? e.message : String(e),
            },
            "refusing to follow redirect — SSRF guard rejected target",
          );
          return null;
        }
        if (!sameSite(inputUrl, next.toString())) {
          this.log.warn(
            { from: current.toString(), to: next.toString() },
            "refusing to follow redirect — off-site",
          );
          return null;
        }
        current = next;
        continue;
      }

      if (!res.ok) {
        this.log.warn(
          { url: current.toString(), status: res.status },
          "cheerio fetch returned non-2xx",
        );
        return null;
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      return { url: current, text: this.extractMainText($), html, $ };
    }

    this.log.warn({ url: inputUrl }, "too many redirects");
    return null;
  }

  private async fetchCloudflareCrawl(url: URL, opts: FetchOpts): Promise<PageContent | null> {
    const { cloudflareAccountId: account, cloudflareApiToken: token } = this.config;
    if (!account || !token) return null;

    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/content`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.toString() }),
        timeoutMs: opts.timeoutMs ?? 15000,
        signal: opts.signal,
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.log.warn(
        { url: url.toString(), status: res.status, body: body.slice(0, 300) },
        "cloudflare fetch returned non-2xx",
      );
      return null;
    }

    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: string;
      errors?: Array<{ code: number; message: string }>;
    } | null;

    if (!data) {
      this.log.warn({ url: url.toString() }, "cloudflare returned non-JSON response");
      return null;
    }
    if (!data.success) {
      this.log.warn(
        { url: url.toString(), errors: data.errors },
        "cloudflare API reported success=false",
      );
      return null;
    }
    if (typeof data.result !== "string") {
      this.log.warn(
        { url: url.toString(), resultType: typeof data.result },
        "cloudflare success but no string result",
      );
      return null;
    }
    if (data.result.length < 200) {
      this.log.warn(
        { url: url.toString(), bytes: data.result.length },
        "cloudflare returned thin HTML (likely anti-bot block page)",
      );
      // still parse — caller decides on length threshold
    }

    const $ = cheerio.load(data.result);
    return { url, text: this.extractMainText($), html: data.result, $ };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
