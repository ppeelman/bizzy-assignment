import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnrichmentResponse, ErrorResponse } from "../src/core/types";

interface Company {
  url: string;
  tier: "big-us" | "mid-eu" | "small-be" | "obscure";
  expected: {
    industry_keywords: string[];
    known_executives: string[];
    recent_news_keywords_any: string[];
  };
}

interface CompanyResult {
  company: Company;
  ok: boolean;
  data?: EnrichmentResponse;
  error?: ErrorResponse;
  status?: number;
  metrics: {
    summary_present: boolean;
    industry_match: boolean;
    contacts_returned: number;
    contacts_recall: number;
    contacts_precision: number;
    news_present: boolean;
    news_keyword_match: boolean;
    runtime_ms: number;
    confidence_distribution: { verified: number; inferred: number; unknown: number };
  };
}

const EVAL_TARGET = Bun.env.EVAL_TARGET ?? "http://localhost:3000";
const EVAL_DEMO_KEY = Bun.env.EVAL_DEMO_KEY;

async function callApi(
  url: string,
): Promise<{ ok: boolean; data?: EnrichmentResponse; error?: ErrorResponse; status: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${EVAL_TARGET}/api/enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EVAL_DEMO_KEY ? { "X-Demo-Key": EVAL_DEMO_KEY } : {}),
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(75_000),
    });
    const body = await res.json();
    if (!res.ok) {
      return { ok: false, error: body as ErrorResponse, status: res.status };
    }
    const data = body as EnrichmentResponse;
    data._debug.elapsed_ms = data._debug.elapsed_ms || Date.now() - t0;
    return { ok: true, data, status: res.status };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: { error: "internal_error", reason: e instanceof Error ? e.message : String(e) },
    };
  }
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function contactsMatch(
  returnedNames: string[],
  expected: string[],
): { recall: number; precision: number } {
  if (expected.length === 0 && returnedNames.length === 0) return { recall: 1, precision: 1 };
  if (returnedNames.length === 0) return { recall: 0, precision: 1 };
  const expLower = expected.map((e) => e.toLowerCase());
  const matches = returnedNames.filter((n) => {
    const nl = n.toLowerCase();
    return expLower.some((e) => nl.includes(e) || e.includes(nl));
  });
  const recall =
    expected.length === 0 ? 1 : Math.min(matches.length, expected.length) / expected.length;
  const precision = matches.length / returnedNames.length;
  return { recall, precision };
}

function evalCompany(company: Company, data: EnrichmentResponse): CompanyResult["metrics"] {
  const summary_present = Boolean(data.summary?.value);

  const industryStr = lower(data.industry?.value);
  const industry_match =
    industryStr.length > 0 &&
    company.expected.industry_keywords.some((k) => industryStr.includes(k.toLowerCase()));

  const contactNames = data.contacts.map((c) => c.name.value ?? "").filter(Boolean);
  const { recall, precision } = contactsMatch(contactNames, company.expected.known_executives);

  const news_present = data.news.length > 0;
  const newsTitles = data.news.map((n) => lower(n.title.value)).join(" ");
  const news_keyword_match =
    newsTitles.length > 0 &&
    company.expected.recent_news_keywords_any.some((k) => newsTitles.includes(k.toLowerCase()));

  const dist = { verified: 0, inferred: 0, unknown: 0 };
  for (const f of [data.summary, data.industry] as Array<{ confidence?: string }>) {
    if (f?.confidence === "verified") dist.verified++;
    else if (f?.confidence === "inferred") dist.inferred++;
    else dist.unknown++;
  }
  for (const c of data.contacts) {
    if (c.name.confidence === "verified") dist.verified++;
    else if (c.name.confidence === "inferred") dist.inferred++;
    else dist.unknown++;
  }
  for (const n of data.news) {
    if (n.title.confidence === "verified") dist.verified++;
    else if (n.title.confidence === "inferred") dist.inferred++;
    else dist.unknown++;
  }

  return {
    summary_present,
    industry_match,
    contacts_returned: data.contacts.length,
    contacts_recall: recall,
    contacts_precision: precision,
    news_present,
    news_keyword_match,
    runtime_ms: data._debug.elapsed_ms,
    confidence_distribution: dist,
  };
}

async function main() {
  const companiesPath = path.join(import.meta.dir, "companies.json");
  const companies: Company[] = JSON.parse(readFileSync(companiesPath, "utf-8"));

  console.log(`Eval target: ${EVAL_TARGET}`);
  console.log(`Companies:   ${companies.length}`);
  console.log();

  console.log("Warming up target…");
  await callApi("https://example.com").catch(() => undefined);

  const results: CompanyResult[] = [];
  for (const company of companies) {
    process.stdout.write(`→ ${company.url} `);
    const t0 = Date.now();
    const apiResult = await callApi(company.url);
    if (!apiResult.ok || !apiResult.data) {
      console.log(`FAIL (${apiResult.status}) ${apiResult.error?.error ?? "unknown"}`);
      results.push({
        company,
        ok: false,
        error: apiResult.error,
        status: apiResult.status,
        metrics: {
          summary_present: false,
          industry_match: false,
          contacts_returned: 0,
          contacts_recall: 0,
          contacts_precision: 0,
          news_present: false,
          news_keyword_match: false,
          runtime_ms: Date.now() - t0,
          confidence_distribution: { verified: 0, inferred: 0, unknown: 0 },
        },
      });
    } else {
      const metrics = evalCompany(company, apiResult.data);
      console.log(
        `${(metrics.runtime_ms / 1000).toFixed(1)}s ` +
          `[summary:${metrics.summary_present ? "✓" : "✗"} ` +
          `industry:${metrics.industry_match ? "✓" : "✗"} ` +
          `contacts:${metrics.contacts_returned}/${company.expected.known_executives.length} ` +
          `news:${metrics.news_present ? "✓" : "✗"}]`,
      );
      results.push({ company, ok: true, data: apiResult.data, status: 200, metrics });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const md = renderMarkdown(results);
  const outPath = path.join(import.meta.dir, "results.md");
  writeFileSync(outPath, md);
  console.log(`\nWrote ${outPath}`);
}

function renderMarkdown(results: CompanyResult[]): string {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;

  const aggregate = (predicate: (r: CompanyResult) => boolean): string =>
    `${results.filter(predicate).length}/${total}`;

  const tier = (t: string) => results.filter((r) => r.company.tier === t);
  const tierAvg = (t: string, key: keyof CompanyResult["metrics"]): string => {
    const ts = tier(t).filter((r) => r.ok);
    if (ts.length === 0) return "—";
    const sum = ts.reduce((acc, r) => acc + (Number(r.metrics[key]) || 0), 0);
    return (sum / ts.length).toFixed(2);
  };

  const lines: string[] = [];
  lines.push("# Eval Results");
  lines.push("");
  lines.push(`- **Target:** ${EVAL_TARGET}`);
  lines.push(`- **Ran at:** ${new Date().toISOString()}`);
  lines.push(`- **Model:** ${results.find((r) => r.ok)?.data?._debug.model ?? "unknown"}`);
  lines.push(`- **Companies:** ${total} (${ok} ok, ${total - ok} failed)`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`- Summary present: **${aggregate((r) => r.metrics.summary_present)}**`);
  lines.push(`- Industry match: **${aggregate((r) => r.metrics.industry_match)}**`);
  lines.push(`- News present: **${aggregate((r) => r.metrics.news_present)}**`);
  lines.push(`- News keyword match: **${aggregate((r) => r.metrics.news_keyword_match)}**`);
  lines.push("");
  lines.push("## By tier");
  lines.push("");
  lines.push("| Tier | n | summary | industry | contacts (recall) | news | avg s |");
  lines.push("|------|---|---------|----------|-------------------|------|-------|");
  for (const t of ["big-us", "mid-eu", "small-be", "obscure"]) {
    const ts = tier(t);
    if (ts.length === 0) continue;
    const okTs = ts.filter((r) => r.ok);
    lines.push(
      `| ${t} | ${ts.length} | ${okTs.filter((r) => r.metrics.summary_present).length}/${ts.length} | ${okTs.filter((r) => r.metrics.industry_match).length}/${ts.length} | ${tierAvg(t, "contacts_recall")} | ${okTs.filter((r) => r.metrics.news_present).length}/${ts.length} | ${(okTs.reduce((a, r) => a + r.metrics.runtime_ms, 0) / Math.max(1, okTs.length) / 1000).toFixed(1)} |`,
    );
  }
  lines.push("");
  lines.push("## Per-company");
  lines.push("");
  lines.push("| Company | Tier | Summary | Industry | Contacts | News | Runtime | Notes |");
  lines.push("|---------|------|---------|----------|----------|------|---------|-------|");
  for (const r of results) {
    const host = (() => {
      try {
        return new URL(r.company.url).hostname.replace(/^www\./, "");
      } catch {
        return r.company.url;
      }
    })();
    if (!r.ok) {
      lines.push(`| ${host} | ${r.company.tier} | ✗ | ✗ | — | — | — | ${r.error?.error ?? "?"} |`);
      continue;
    }
    const m = r.metrics;
    lines.push(
      `| ${host} | ${r.company.tier} | ${m.summary_present ? "✓" : "✗"} | ${m.industry_match ? "✓" : "✗"} | ${m.contacts_returned}/${r.company.expected.known_executives.length || "—"} | ${m.news_present ? "✓" : "✗"}${m.news_keyword_match ? "" : "*"} | ${(m.runtime_ms / 1000).toFixed(1)}s | ${m.confidence_distribution.verified}v/${m.confidence_distribution.inferred}i/${m.confidence_distribution.unknown}u |`,
    );
  }
  lines.push("");
  lines.push("`*` = news returned but no expected keyword matched.");
  lines.push("");
  lines.push(
    "Confidence distribution `Xv/Yi/Zu` = verified / inferred / unknown across summary + industry + each contact + each news item.",
  );

  return `${lines.join("\n")}\n`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
