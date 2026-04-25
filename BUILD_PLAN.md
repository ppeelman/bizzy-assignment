# Implementation Plan

Stack: Bun + Hono (API) + Vite React (frontend) + Anthropic SDK (Citations API) + Tavily (search) + Cheerio (scrape) + fast-xml-parser (Google News RSS) + Fly.io (deploy).

Ordered phases. Each one has a checkpoint — don't move on until it passes.

---

## Phase 0 — Citations API spike (15-20 min, throwaway)

De-risks the thesis before the main build. If anything here surprises, adjust Phase 3 before you start it rather than discovering it mid-pipeline.

Create `spike/citations.ts` (delete after Phase 3 works):

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: Bun.env.ANTHROPIC_API_KEY });

// Two small synthetic documents so the test runs in <10s
const docs = [
  { source_url: "https://acme.example/about",
    text: "Acme Corp was founded in 2015 by Jan Peeters. The company is headquartered in Gent, Belgium." },
  { source_url: "https://tech.example/news",
    text: "Acme raised €8M in Series A funding led by Index Ventures in March 2026." },
];

const response = await client.messages.create({
  model: Bun.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  messages: [{
    role: "user",
    content: [
      ...docs.map(d => ({
        type: "document" as const,
        source: { type: "text" as const, media_type: "text/plain" as const, data: d.text },
        title: d.source_url,
        citations: { enabled: true },
      })),
      { type: "text" as const,
        text: `Return JSON: {"founder": {"value": "...", "supporting_quote": "..."}, "hq": {"value": "...", "supporting_quote": "..."}, "funding": {"value": "...", "supporting_quote": "..."}}. Every value must have a quote copied verbatim from the documents.` },
    ],
  }],
});

// Inspect what came back — this is the reality check
console.log(JSON.stringify(response.content, null, 2));
```

**Verify these questions with the real response:**

1. **Does each text block have a `citations` array?** Look for `response.content[i].citations` on `type: "text"` blocks.
2. **Does each citation carry `cited_text`?** This is the span we match `supporting_quote` against.
3. **Does each citation carry the document title back?** Look for `document_title` — if yes, use it directly. If the field is named differently (e.g., `document_index`), you need a `documents[index]` lookup table. Adjust `src/claude.ts:reconcileCitations` accordingly.
4. **Does `supporting_quote` fidelity survive?** Does Claude's emitted `supporting_quote` string containment-match against the cited_text verbatim, or does whitespace/punctuation drift? If drift happens, you'll need normalization on both sides (see Phase 3 reconciliation spec).

**Checkpoint:** you can point at the response object and confirm which field names exist. If the shape differs from what Phase 3 assumes, spend 10 min updating the reconciliation spec before moving on.

**Also spike Cloudflare Browser Run** (5 min, same `spike/` dir):

```ts
const CF = Bun.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = Bun.env.CLOUDFLARE_API_TOKEN;
const t0 = Date.now();
const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF}/browser-rendering/crawl`,
  {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://framer.com" }),
  },
);
console.log("status", res.status, "elapsed", Date.now() - t0, "ms");
console.log(await res.json());
```

Verify against the real API ([https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/)):

1. Where is the rendered HTML/text in the response? (likely `result.html` or `result.markdown`)
2. What does failure look like (4xx vs `success: false`)?
3. Latency baseline on a single call.

If the API returns markdown directly, the fallback path can skip the Cheerio re-parse. Adjust `fetchCloudflareCrawl()` in Phase 2 to whatever the real shape is.

`rm -rf spike/` when both Phase 3 and the CF fallback work end-to-end.

---

## Phase 1 — Setup

```bash
mkdir bizzy-enrichment && cd bizzy-enrichment
bun init -y
bun add hono @anthropic-ai/sdk cheerio zod fast-xml-parser
bun add -d @types/bun vite @vitejs/plugin-react react react-dom @types/react @types/react-dom
# Confirm which lockfile name bun wrote (either bun.lockb binary or bun.lock text since Bun 1.1+)
ls bun.lock bun.lockb 2>/dev/null
```

The `Dockerfile` below assumes you know which lockfile name you got. If `bun.lock` (text) exists, use that in the `COPY` line. If `bun.lockb` (binary) exists, use that. A missing-match `COPY` silently skips and you'll get slow installs with no lockfile in the container. Pin it.

Files to create:
- `.env.example` → `ANTHROPIC_API_KEY=`, `TAVILY_API_KEY=`, `ANTHROPIC_MODEL=claude-sonnet-4-5-20250929`, `CLOUDFLARE_ACCOUNT_ID=`, `CLOUDFLARE_API_TOKEN=` (free tier covers demo usage; required for JS-heavy fallback), `DEMO_KEY=` (empty for local dev, set in Fly for prod)
- `.env` (gitignored) with real keys
- `src/server.ts` → Hono app with:
  - Boot-time guard on `DEMO_KEY` when `NODE_ENV=production` (see Phase 6)
  - POST `/api/enrich` route with **60s global request timeout** (configurable via `TIMEOUT_MS` env, default 60_000). Why 60s not 30s: document-capped Claude calls can take 10-15s, plus source fetches 5-10s, plus cold DNS lookups — total can exceed 30s without being broken.
  - GET `/health` → 200 ok
  - **Static asset serving:** `app.use("/*", serveStatic({ root: "./dist" }))` so the built SPA is served at the root path. In dev, Vite handles this; in prod, Hono does.
  - CORS only if frontend were cross-origin (same-origin in our setup, so skip CORS entirely — one fewer thing to get wrong)
- `src/types.ts` → Zod schemas for the enrichment output; use `@hono/zod-validator` for request-body validation on `/api/enrich`
- `src/ssrf.ts` → URL safety guard (see Phase 2)
- `src/name.ts` → company-name extraction (see Phase 2)
- `vite.config.ts` + `index.html` + `src/ui/App.tsx` (bare-bones React). Vite dev server proxies `/api/*` to `http://localhost:3000` so local dev works without CORS.

**Checkpoint:** `bun run src/server.ts` boots, `curl localhost:3000/health` returns `ok`.

---

## Phase 2 — Source fetcher

**Source ordering.** The architecture diagram shows sources in parallel, but there's a real dependency: Tavily and Google News both need `companyName`, which comes from the homepage. Order: `fetchHomepage` → then `fetchLinkedPages`, `fetchTavily`, `fetchGoogleNews`, etc. fire in parallel (`Promise.allSettled`). If homepage fails, skip the downstream fetches and return the error (Layer 3 source-quality gate).

**SSRF guard (run before any fetch).** In `src/ssrf.ts`:

```ts
// Reject: non-http(s), private/loopback/link-local, non-standard ports.
// RFC 1918: 10/8, 172.16/12, 192.168/16. RFC 3927: 169.254/16. IPv6 loopback ::1.
export async function assertSafeUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("unsupported_scheme");
  if (u.port && !["", "80", "443"].includes(u.port)) throw new Error("unsupported_port");
  // Resolve host to IPs and reject private ranges
  const { address } = await dns.promises.lookup(u.hostname);
  if (isPrivateIp(address)) throw new Error("private_address");
  return u;
}
```

Use `ip-regex` or hand-roll `isPrivateIp` (10 lines). Call `assertSafeUrl(input)` on the enrichment request before anything else. Also call it on every URL before following Google News redirects.

**Company name extraction (`src/name.ts`).** Fallback chain, applied after homepage fetch:

```ts
export function extractCompanyName($: CheerioAPI, url: URL): string {
  const og = $('meta[property="og:site_name"]').attr("content");
  if (og && og.trim()) return og.trim();
  const title = $("title").text().split(/[|·–—-]/)[0].trim();  // Strip "| tagline"
  if (title && title.length > 1 && title.length < 80) return title;
  return url.hostname.replace(/^www\./, "").split(".")[0];  // "stripe.com" → "stripe"
}
```

Rationale: `og:site_name` is maintained for brand accuracy; `<title>` usually has "Company | Tagline"; domain root is the honest last resort.

---

**Fetcher functions:**

- `fetchHomepage(url)` — `fetch` with 5s timeout, User-Agent, follow redirects, verify final domain matches input. Parse with Cheerio, extract `<title>`, meta description, `<main>` or `<body>` text (strip scripts/nav/footer). Return `{ url, text, $, fetched_at, source: "cheerio" | "cloudflare" }` or `null`. Expose the Cheerio `$` so `extractCompanyName` and `fetchLinkedPages` can reuse it without re-parsing. **Fallback to Cloudflare Browser Run** when Cheerio extraction returns <200 chars of meaningful text — the JS-only sites case (Webflow, Framer, heavy Next.js marketing).
- `fetchCloudflareCrawl(url)` — POST to `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/browser-rendering/crawl` with `Authorization: Bearer ${CF_TOKEN}` and `{url}` body. 15s timeout (real-browser render takes 2-5s typical, 10s+ on cold starts). Parse the response per the Phase 0 spike findings — likely `result.html` or `result.markdown`. If `markdown`, skip Cheerio re-parse and use the markdown directly as `text`. If `html`, run it through Cheerio for consistency. Tag the returned object with `source: "cloudflare"` so debug output shows which fetcher fired. **Important:** still run `assertSafeUrl(url)` before calling Cloudflare — we don't outsource SSRF defense to a third party.

**Cheerio → Cloudflare fallback flow:**

```ts
async function fetchHomepage(url: URL): Promise<HomepageResult | null> {
  const cheerioResult = await fetchWithCheerio(url).catch(() => null);
  if (cheerioResult && cheerioResult.text.length >= 200) {
    return { ...cheerioResult, source: "cheerio" };
  }
  // JS-only site or empty response → real browser render
  if (!Bun.env.CLOUDFLARE_API_TOKEN) {
    return cheerioResult; // CF not configured, ship what we got
  }
  const cfResult = await fetchCloudflareCrawl(url).catch(() => null);
  if (cfResult && cfResult.text.length >= 200) {
    return { ...cfResult, source: "cloudflare" };
  }
  return cheerioResult ?? null; // both failed, return whatever we have
}
```
- `fetchLinkedPages(baseUrl, $)` — find `<a>` tags with text/href containing `about|team|company|people`. Fetch up to 3 of them. Same extraction.
- `fetchTavily(companyName)` — Tavily POST `/search` with `{ query: companyName, topic: "news", max_results: 5 }`. Return `[{ title, url, content, published_date }, ...]`. Citable snippets — feeds synthesis fields.
- `fetchGoogleNews(companyName, locale)` — hit `https://news.google.com/rss/search?q="${company}"&hl=${locale}&gl=${gl}&ceid=${gl}:${hl}` (e.g., `hl=nl-BE`, `gl=BE`). Parse with `fast-xml-parser`. For each item, follow the Google redirect (`fetch(link, { redirect: "manual" })` → read `Location` header) in parallel to get the real source URL. Return `[{ title, url, publishedAt, source }, ...]`. Title-only — feeds `news` field.
- `localeFromTld(hostname)` — `.be → nl-BE` (guess wrong 40% of the time — accept it), `.fr → fr-FR`, `.de → de-DE`, `.nl → nl-NL`, default `en-US`. Also call with `en-US` in parallel for any company — don't miss English press for `.be` firms. For `.be` specifically, query both `nl-BE` and `fr-BE` — dedup takes care of overlap.
- `bundleDocuments(fetched)` — produce `[{ type: "homepage" | "about" | "team" | "tavily_news" | "gnews", source_url, text }, ...]`. For Google News items, the `text` is just `"${title} — ${source} — ${publishedAt}"` (short but enough for the `news` field citation).
- **Dedup news at merge time:** normalize URLs (strip `utm_*`, lowercase host), sort by `publishedAt` desc, keep top 2 unique.

**Error handling (don't skip):** every source fetch wrapped in try/catch. On failure, log + push `{ type, source_url, error: "..." }` to a `failures` array. Keep going with whatever succeeded. If *all* sources fail, skip the Claude call entirely and return `{ error: "source_fetch_failed", failures: [...] }`. The UI surfaces this instead of calling Claude on an empty bundle (which would produce confident nothing).

Same pattern for the Claude call itself: one try/catch, surface upstream 429s/timeouts as an error state, never silently empty-out.

**Two specific error paths to get right (critical failure modes):**
- **`fetchGoogleNews` XML parse:** `fast-xml-parser` throws on malformed XML. Wrap `new XMLParser().parse(xml)` in try/catch — on failure, push `{type: "gnews", error: "xml_parse_failed"}` to `failures` and return `[]`. Don't let one bad feed kill the whole request.
- **`callClaude` JSON extraction:** Claude's response is text. The schema prompt asks for JSON but sometimes you get prose around the JSON, or trailing commentary. Extract the JSON safely — find the first `{` and last `}`, `JSON.parse` in try/catch. On parse failure, return `{error: "claude_parse_failed", raw_response: response.content[0].text}` so the failure is visible in debug instead of a 500.

**Checkpoint:** `curl -X POST localhost:3000/api/enrich -d '{"url":"https://stripe.com"}' | jq '.debug.sources | length'` returns > 5.

---

## Phase 3 — Claude Citations call + validator

In `src/claude.ts`:

- Build the `documents` array in the Citations API shape:
  ```ts
  {
    role: "user",
    content: [
      {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: doc.text },
        title: doc.source_url,
        citations: { enabled: true }
      },
      // ...one block per fetched doc
      { type: "text", text: instructionPrompt }
    ]
  }
  ```
- System prompt: "You are Bizzy's enrichment engine. Using only the attached documents, produce the JSON output below. For every factual field, include a `supporting_quote` copied verbatim from the documents. If the documents don't support a field, set `value: null`."
- Schema in the user prompt (prose JSON Schema, not tool_use): each verifiable field returns `{value, supporting_quote}`. `reasons` is plain strings — it's synthesized across multiple sources and is `inferred` by construction, no per-item citation required. Example:
  ```json
  {
    "summary": {"value": "...", "supporting_quote": "..."},
    "industry": {"value": "...", "supporting_quote": "..."},
    "reasons": ["...", "...", "..."],
    "contacts": [
      { "name": {"value": "Jan Peeters", "supporting_quote": "..."}, "role": {"value": "Founder", "supporting_quote": "..."}, "why": "..." }
    ],
    "news": [
      { "title": {"value": "...", "supporting_quote": "..."}, "url": "...", "date": "..." }
    ]
  }
  ```
- Model: read from `ANTHROPIC_MODEL` env var (defaulted in code), pin the default to a specific version ID like `claude-sonnet-4-5-20250929`. Document the exact version actually used in the README so Bizzy can reproduce.
- **Reconciliation (corrected, with Phase 0 findings applied).** The Citations API returns the assistant message as an array of content blocks. Each `type: "text"` block carries a `citations` array, and every citation has a `cited_text` field containing the literal span quoted from one of your source documents, plus a `document_index` (always) and `document_title` (the title you passed in, if the SDK version returns it). Reconciliation is:

  ```ts
  // Normalize to survive whitespace drift, smart quotes, case differences
  function normalize(s: string): string {
    return s
      .replace(/[  -​  ]/g, " ") // non-breaking + zero-width whitespace
      .replace(/[‘’“”]/g, '"')         // smart quotes → straight
      .replace(/\s+/g, " ")                                // collapse whitespace
      .trim()
      .toLowerCase();
  }

  // 1. Flatten all citations across all text blocks in the response
  // Fallback: if Claude's SDK doesn't return document_title, build a lookup from document_index
  const allCitations = response.content
    .filter(b => b.type === "text")
    .flatMap(b => (b.citations ?? []).map(c => ({
      cited_text: c.cited_text,
      source_url: c.document_title ?? docs[c.document_index]?.source_url ?? "unknown",
    })));

  // 2. For each field's supporting_quote, find the citation whose cited_text matches (normalized)
  function attach(quote: string): { source_url: string; confidence: "verified" } | { confidence: "inferred" } {
    const q = normalize(quote);
    const hit = allCitations.find(c => {
      const t = normalize(c.cited_text);
      return t.includes(q) || q.includes(t);
    });
    return hit ? { source_url: hit.source_url, confidence: "verified" } : { confidence: "inferred" };
  }
  ```

  No field-to-citation span mapping needed — we match by content, not position. Normalization on both sides survives whitespace drift, smart-quote substitution, and case differences in how Claude emits `supporting_quote` vs how it appears in `cited_text`. Without this, you'll see false `inferred` labels on legitimately-grounded fields and your eval numbers will tank silently.

- **Document cap.** Hard-cap the document bundle at 8 before calling Claude. If you fetched more (homepage + 3 /about pages + 5 news = 9+), rank by source type priority (homepage > about > team > news-deduped) and keep the top 8. Citations API latency scales with document count; 8 is the sweet spot for ~10-15s calls vs the 20-30s you get at 15+ docs, which would blow the 60s global timeout on cold path.

In `src/validate.ts`:

- For every `contacts[].name.value` and `news[].title.value`: string-contain check against the matched `supporting_quote`. If the entity isn't literally in the quote, drop the contact/news item.
- If no supporting_quote resolved to a citation span, drop the field (Layer 1).
- If fewer than the target counts remain, ship what you have (don't pad).
- Dedup contacts by normalized name; dedup news by URL.

**Checkpoint:** `curl` returns a JSON object with `summary`, `industry`, `reasons`, `contacts`, `news`, each verified field carrying a `source_url` and `confidence`.

**Scope reduction fallback:** if any of the above gets hairier than expected (Citations reconciliation is the likely trouble spot), the honest cuts in order are: (1) drop the `/team` fetch — contacts degrade but the pipeline still ships, (2) drop Tavily — Google News alone still produces titles/URLs for the `news` field. Keep Google News; it's the cheap win for the EU SME case. Don't cut the validator — the validator *is* the point.

---

## Phase 3.5 — Smoke tests (3 focused tests on the riskiest paths)

Not CI-grade coverage. Three tests on the three paths most likely to be wrong and most damaging if they are. Uses Bun's built-in test runner (`bun test`) — zero config.

**`test/ssrf.test.ts`** — security code with no tests is a red flag.

```ts
import { describe, expect, test } from "bun:test";
import { assertSafeUrl } from "../src/ssrf";

describe("assertSafeUrl", () => {
  test("rejects loopback", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://localhost/")).rejects.toThrow();
  });
  test("rejects RFC 1918 private ranges", async () => {
    await expect(assertSafeUrl("http://10.0.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://192.168.1.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://169.254.169.254/")).rejects.toThrow(); // AWS metadata
  });
  test("rejects non-http schemes", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertSafeUrl("ftp://example.com/")).rejects.toThrow();
  });
  test("accepts public https URL", async () => {
    await expect(assertSafeUrl("https://stripe.com/")).resolves.toBeDefined();
  });
});
```

**`test/validate.test.ts`** — the containment check *is* the system's core grounding guarantee.

```ts
import { describe, expect, test } from "bun:test";
import { validate } from "../src/validate";

test("drops contacts whose name is not in the supporting_quote", () => {
  const input = {
    contacts: [
      { name: { value: "Jan Peeters", supporting_quote: "Founded by Jan Peeters in 2015" }, role: {...}, why: "..." },
      { name: { value: "Sarah Chen", supporting_quote: "our leadership team" }, role: {...}, why: "..." }, // hallucinated
    ],
    // ... other fields
  };
  const out = validate(input, /* citation map */);
  expect(out.contacts).toHaveLength(1);
  expect(out.contacts[0].name.value).toBe("Jan Peeters");
});
```

**`test/reconcile.test.ts`** — the trickiest logic; if this is wrong, every field is wrong.

```ts
import { describe, expect, test } from "bun:test";
import { reconcileCitations } from "../src/claude";

test("quote present in a citation's cited_text → verified + source_url", () => {
  const citations = [{ cited_text: "Founded by Jan Peeters in 2015", source_url: "https://acme.be/about" }];
  const result = reconcileCitations("Jan Peeters", citations);
  expect(result.confidence).toBe("verified");
  expect(result.source_url).toBe("https://acme.be/about");
});
test("quote not in any citation → inferred, no source_url", () => {
  const citations = [{ cited_text: "our leadership team", source_url: "https://acme.be/about" }];
  const result = reconcileCitations("Sarah Chen", citations);
  expect(result.confidence).toBe("inferred");
  expect((result as any).source_url).toBeUndefined();
});
```

**`test/auth.test.ts`** — auth middleware behavior. Specifically guards against the "silent bypass if empty string" failure mode.

```ts
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";

describe("demo-key middleware", () => {
  test("DEMO_KEY undefined → open access (local dev mode)", async () => {
    const app = createApp({ DEMO_KEY: undefined });
    const res = await app.request("/api/enrich", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).not.toBe(401);
  });
  test("DEMO_KEY set, correct header → 200/normal processing", async () => {
    const app = createApp({ DEMO_KEY: "test-key" });
    const res = await app.request("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Key": "test-key" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).not.toBe(401);
  });
  test("DEMO_KEY set, wrong header → 401", async () => {
    const app = createApp({ DEMO_KEY: "test-key" });
    const res = await app.request("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Key": "wrong" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(401);
  });
});
```

Note: `createApp({ DEMO_KEY })` is a factory function in `src/server.ts` that takes the key via parameter instead of reading `Bun.env` directly. Makes the middleware testable. If you prefer to read env directly, use `Bun.env.DEMO_KEY = ...` + `delete Bun.env.DEMO_KEY` in test setup, but the factory pattern is cleaner.

**Checkpoint:** `bun test` passes all 4 test files (3 original + this one).

If you're under pressure and have to drop one: keep `validate.test.ts` (grounding guarantee), `ssrf.test.ts` (security), and `auth.test.ts` (prevents silent production bypass). `reconcile.test.ts` is the one you can punt on — if Phase 3 works end-to-end on real data, the reconciliation obviously works.

---

## Phase 4 — Frontend

In `src/ui/App.tsx`:

**Layout & information architecture (desktop, 900px max-width centered):**

```
┌────────────────────────────────────────────────────────┐
│  Bizzy Enrichment                         [Demo Mode]  │  ← header (48px)
├────────────────────────────────────────────────────────┤
│  [ https://acme.com           ] [ Enrich → ]           │  ← input bar
├────────────────────────────────────────────────────────┤
│                                                         │
│  ACME Corp                                   Fintech ▸ │  ← h1 + industry
│  Two-sentence summary goes here. It describes what     │  ← summary (biggest body)
│  the company does in language a rep can paste into     │
│  an email draft.                        ↳ acme.com/about│  ← inline source
│                                                         │
│  WHY REACH OUT                                          │  ← section label
│  1. Their recent Series B signals growth in ops tools  │
│  2. Founder publicly mentioned struggling with X       │
│  3. Hiring 3 SDRs — buying mode                        │
│                                                         │
│  CONTACTS (2)              │  RECENT NEWS (2)           │  ← two-column
│  ┌─────────────────────┐   │  ┌─────────────────────┐   │
│  │ Jan Peeters         │   │  │ Acme raises €12M    │   │
│  │ Founder & CEO       │   │  │ Tech.eu · 3d ago    │   │
│  │ •verified ↳ acme.be │   │  │ •verified ↳ tech.eu │   │
│  └─────────────────────┘   │  └─────────────────────┘   │
│                                                         │
└────────────────────────────────────────────────────────┘
```

**Hierarchy (what the rep sees in order):**
1. Company name + industry (largest type, answer to "what")
2. Summary (biggest body text, answer to "why care")
3. Reasons to reach out (numbered, not bulleted — implies ranking)
4. Contacts + news side-by-side (the action material, visually equivalent)
5. Source chips + confidence dots inline with each field (secondary but always visible)

Mobile (<720px): single column stack. Contacts + news collapse below each other, not side-by-side.

- URL input + "Enrich" button.
- `POST /api/enrich` on submit with `X-Demo-Key` header from localStorage.
- Loading state: skeleton card matching the real card's shape (summary block, reasons block, two side-by-side card blocks). Keeps layout stable when data lands.
- Result card: summary, industry, reasons, contacts, news — with per-field source chips and confidence dots (see Pass 2 spec below).
- Empty-state messaging for `contacts: []` and `news: []` — "No verified contacts found on the company's own pages. Production would use Proxycurl / PDL / Cognism for deeper lookup." — visibly honest, not an empty void.

No router, no state library, no design system. Tokens inline in `index.css` (see Typography + Confidence System specs below).

**Typography (ships with the project — Google Fonts `<link>` in index.html):**

- Headings: **Inter** or **Söhne** if available, 600 weight. If sticking with free Google: **Inter** is fine but fights generic; **Instrument Sans** or **Geist** differentiate better. Pick one.
- Body: **Inter** 400, 16px minimum. Never smaller.
- Monospace (for URLs in source chips): **JetBrains Mono** 400, 13px.
- Never system-ui as the primary font. System-ui is the "I gave up on typography" signal — and that's exactly the slop tell a Bizzy reviewer will register without articulating why.

**Color tokens (CSS variables in `:root`):**

```css
:root {
  --bg:           #fafaf9;       /* warm off-white, not pure #fff */
  --surface:      #ffffff;       /* cards */
  --ink:          #1a1a1a;       /* body */
  --ink-muted:    #6b6b6b;       /* secondary */
  --ink-faint:    #a8a8a8;       /* tertiary, source chips */
  --accent:       #2563eb;       /* one accent color, used sparingly — CTA + links */
  --accent-hover: #1d4ed8;
  --verified:     #16a34a;       /* green */
  --inferred:     #ca8a04;       /* amber */
  --unknown:      #a8a8a8;       /* gray */
  --error:        #dc2626;
  --rule:         #e7e5e4;       /* hairline dividers */
}
```

One accent color. Warm neutral background (not pure white, not pure black). Confidence system gets its own three colors — that's where color work actually matters.

**Border-radius scale (deliberately varied, not uniform):**

- Inputs: `6px`
- Buttons: `6px`
- Cards: `10px`
- Pills/chips: `999px` (fully rounded — these are labels, not containers)
- Avoid: every element at the same radius. That's AI slop #5.

**What we're NOT doing** (AI slop blacklist, explicitly avoided):

- No purple/indigo gradient backgrounds
- No 3-column icon-in-circle feature grid (we don't have "features" to display)
- No centered everything — main view is left-aligned body with the page centered in viewport
- No uniform bubbly border-radius
- No decorative floating blobs or wavy SVG dividers
- No emoji as design elements
- No colored left-border on cards (one subtle rule line only, if any)
- No "Welcome to Bizzy Enrichment" hero copy

**Responsive breakpoints:**

- **≥ 900px:** Centered 900px max-width column. Contacts + News side-by-side in a 2-column grid.
- **720–899px:** Full width with 24px outer padding. Contacts + News stack (single column), contacts first.
- **< 720px:** Full width with 16px outer padding. Single column. Input + Enrich button stack vertically. Font size stays 16px (don't zoom-in iOS).

Not "stacked on mobile" — the order is deliberate: contacts first on narrow because on phone the rep is most likely triaging who-to-email.

**Accessibility:**

- All form inputs have visible `<label>` elements (never placeholder-as-label; placeholder disappears the moment the user types, leaving them lost).
- Confidence dots have an adjacent text label — `•verified` not just `•`. Color-only differentiation fails for ~8% of men (red-green colorblindness).
- Touch targets: buttons ≥ 44×44px (CSS: `min-height: 44px`).
- Keyboard nav: Tab order = password input → unlock (prompt), URL input → Enrich → first source chip → ... on result page.
- Focus ring: `outline: 2px solid var(--accent); outline-offset: 2px;` on all interactive elements. No `outline: none` without a replacement.
- Color contrast: body text `--ink` on `--bg` = 15:1 (passes WCAG AAA). `--ink-muted` on `--bg` = 5.7:1 (passes AA for body). `--ink-faint` is only for non-essential metadata.
- Source chips that open external URLs: `<a href="..." target="_blank" rel="noopener noreferrer">` with a small external-link icon after the domain (a11y cue that the link leaves the site).
- Error messages use `role="alert"` so screen readers announce them.
- Rate-limit banner uses `role="status"` (non-urgent announcement).

**Confidence system (the signature UX — this is what the architecture is in service of):**

Each verifiable field carries an inline confidence indicator: colored dot + text label + source link, shown right below the field value in 13px type.

```
Patrick Collison
CEO
• verified · stripe.com/about
```

Three states, three colors:
- **verified** (green `--verified`): has a resolved source_url from the Citations API AND the entity-containment check passed. Source link is clickable.
- **inferred** (amber `--inferred`): no source attribution, Claude synthesized this from context. Still shown, but the label names it. No source link.
- **unknown** (gray `--unknown`): field is `null` in the backend response. Field may be hidden or shown as "—" depending on the field.

**Visual anatomy of one line:**

```html
<span class="conf conf--verified">
  <span class="conf__dot" aria-hidden="true"></span>
  <span class="conf__label">verified</span>
  <span class="conf__sep">·</span>
  <a href="..." class="conf__source" target="_blank" rel="noopener noreferrer">stripe.com/about</a>
</span>
```

CSS:
```css
.conf { font-size: 13px; color: var(--ink-faint); font-family: "JetBrains Mono", ui-monospace, monospace; display: inline-flex; align-items: center; gap: 4px; }
.conf__dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 2px; }
.conf--verified .conf__dot { background: var(--verified); }
.conf--inferred .conf__dot { background: var(--inferred); }
.conf--unknown  .conf__dot { background: var(--unknown);  }
.conf__label { color: var(--ink-muted); }
.conf__source { color: var(--accent); text-decoration: none; border-bottom: 1px dotted currentColor; }
.conf__source:hover { color: var(--accent-hover); border-bottom-style: solid; }
```

**Why this works for a hiring reviewer:**
- Text label means the signal survives grayscale printing and colorblind users — a11y built in, not retrofit.
- Monospace on source link visually separates the chrome from the content (the fact above).
- Dotted underline on source: subtle, distinctive, reads as "click me" without being a loud hyperlink.
- Dot size (6px) stays understated — it's a qualifier, not the main show.
- Every field gets the same pattern — rep develops muscle memory scanning for dot color.

**Implementation check:** this adds ~15 LOC to `index.css` and one small React component `<Confidence field={...} />`. Fits inside the "30 lines of CSS" spirit even if it exceeds the literal count slightly.

**Interaction state coverage:**

| Feature | Loading | Empty | Error | Success | Partial |
|---------|---------|-------|-------|---------|---------|
| Password prompt | — | Centered card: "Bizzy Enrichment Demo", password input, "Unlock" button. Helper text: "Check your submission email for the demo key." | "Invalid key — check your email and try again." (inline, red text below input, clears on next keystroke) | Page reloads into main view | — |
| URL input | Button disabled, spinner in place of "Enrich →" label | — (default state, never "empty" in sense of missing data) | Inline error below input: "Enter a valid http(s) URL." | Submit → loading state | — |
| Enrichment (main body) | Skeleton matches final layout: summary block (3 text lines), reasons block (3 numbered lines), two sibling card blocks. No spinner-in-void. | N/A — success path always produces at least a summary, or falls to error | Card with red left accent: "Couldn't reach acme.com" + specific reason (timeout/404/private IP). "Try another URL" action. | Full result card | Partial = success state with empty-state text inside specific card slots (contacts/news) |
| Contacts card | Skeleton (gray bars matching card shape) | Italic muted text inside card: "No verified contacts found on the company's own pages. Production would use Proxycurl / PDL / Cognism for deeper lookup." | — (contacts errors fold into main enrichment error) | Up to 3 contact rows with name, role, why, source chip, confidence dot | Fewer than 3 contacts → remaining slots show nothing, card sizes to content |
| News card | Skeleton | Italic muted: "No recent news found via Tavily or Google News." | — | Up to 2 articles with title, source, date, chip | 1 article = card with 1 article + empty-state footer |
| Rate-limit hit | — | — | Full-width banner above results: "You've hit the demo rate limit (20/hour). Try again later." — amber, not red. | — | — |
| Cold-start / slow response | After 3s: "Taking longer than usual… Typical enrichment is 8–12s." inline under spinner. | — | After 45s: "Still waiting — the source site may be slow. Showing what we have." | — | — |

**Empty-state copy rules (design principle: empty states are features):**
- Never "No data" or "No results". Name the source, name the production path.
- Contacts empty: acknowledges the choice not to scrape LinkedIn, points to the real answer.
- News empty: acknowledges both source attempts, signals the absence is real not a bug.

**Checkpoint:** Full end-to-end from browser works on `stripe.com` and on a small Belgian domain you pick at random. All 6 states above are reachable by test URLs: `https://stripe.com` (success), `https://this-domain-does-not-exist-12345.com` (error), `https://172.16.0.1` (SSRF reject — should 400 before hitting pipeline), a small Belgian SME (partial).

---

## Phase 5 — Eval harness

Directly answers the brief's "how confident are you?" question with shipped code and actual numbers instead of claims.

**File layout:**
- `eval/companies.json` — 10 hand-verified companies with ground truth
- `eval/run.ts` — runner that hits the API and computes metrics
- `eval/results.md` — committed output, human-readable table

**`eval/companies.json` shape:**

```json
[
  {
    "url": "https://stripe.com",
    "tier": "big-us",
    "expected": {
      "industry_keywords": ["payments", "financial", "fintech", "infrastructure"],
      "known_executives": ["Patrick Collison", "John Collison"],
      "recent_news_keywords_any": ["stablecoin", "AI", "acquisition", "Bridge"]
    }
  }
]
```

Mix: 3 big US (Stripe, Notion, Figma), 3 mid EU (Framer, Mollie, Tessian or similar), 3 small Belgian SMEs (pick real `.be` TLDs, varied industries — could include a Gent-based SaaS, a Brussels consultancy, a Flemish manufacturer), 1 deliberately obscure SME with minimal online presence (stress test).

**Eval runner config (top of `eval/run.ts`):**

```ts
const EVAL_TARGET = Bun.env.EVAL_TARGET ?? "http://localhost:3000";
const EVAL_DEMO_KEY = Bun.env.EVAL_DEMO_KEY;  // required when EVAL_TARGET is deployed

async function callApi(url: string): Promise<EnrichmentResult> {
  const res = await fetch(`${EVAL_TARGET}/api/enrich`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(EVAL_DEMO_KEY ? { "X-Demo-Key": EVAL_DEMO_KEY } : {}),
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(45_000),  // 45s per-company (tolerates any cold-start edge case)
  });
  if (res.status === 401) throw new Error("auth_failed — set EVAL_DEMO_KEY");
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}
```

**Warmup call** (before the main loop, discarded):

```ts
// Warm up the Fly machine before timing anything
console.log("Warming up target...");
await callApi("https://example.com").catch(() => {}); // ignore result
```

**`eval/run.ts` metrics per company:**
- `summary.present` — did we return a non-null summary? (expected: always for non-error cases)
- `industry.keyword_match` — does our industry value contain at least one expected keyword?
- `contacts.recall` — how many of `known_executives` did we find? (0 for small SMEs, expected)
- `contacts.precision` — of the contacts we returned, how many are actually real? Measured strictly against `known_executives` from ground truth. **Do NOT fall back to "has confidence: verified"** — that's circular (counting our own pipeline's output as its own correctness signal). Accept that this metric will be lower on SMEs where ground truth is thin; the number is honest. Optionally, add a `seen_in_source: ["url1", "url2"]` array to ground truth for each known executive so partial-match scoring works when the pipeline finds someone we forgot to list.
- `news.present` — did we return at least one news article?
- `news.keyword_match_any` — does any of our news titles contain any `recent_news_keywords_any`?
- `runtime_ms` — end-to-end latency
- `confidence_distribution` — count of `verified` vs `inferred` vs `unknown` across all fields

**`eval/results.md`** — aggregate table + per-company breakdown. **Always prefix with the target the eval ran against** so a reviewer reading the committed file isn't confused about which environment produced these numbers:

```markdown
# Eval Results

- **Target:** https://bizzy-demo.fly.dev (deployed)
- **Ran at:** 2026-04-23T14:30:00Z
- **Model:** claude-sonnet-4-5-20250929
- **Git commit:** <sha>

| Company | Tier | Summary | Industry | Contacts | News | Runtime |
|---------|------|---------|----------|----------|------|---------|
| stripe.com | big-us | ✓ | ✓ | 2/2 | ✓ | 9.2s |
| ...
```

The header is auto-generated by `eval/run.ts` from the `EVAL_TARGET` env var. Commit a `results.md` that was run against the deployed target, not localhost — the reviewer sees numbers from the URL they can actually hit.

Also: `EVAL_TARGET=https://bizzy-demo.fly.dev bun run eval` runs against the deployed URL, not localhost.

**Checkpoint:** `bun run eval` writes `eval/results.md` with ≥80% field-presence on big-US companies, ≥60% on mid-EU, graceful degradation on small-Belgian.

**Error handling for eval-specific failure modes:**
- Per-company timeout 45s (not the 30s global) to tolerate Fly cold starts on first hit when `EVAL_TARGET` is deployed.
- 1s delay between calls to avoid clustering against Anthropic rate limits (10 companies × 90s still well under Sonnet TPM).
- If any company errors, log the error in `results.md` and continue — don't abort the full eval.

---

## Phase 6 — Fly.io deployment

Makes the reviewer hit a working URL without cloning. Also signals "I know how to put things in production."

**Files:**
- `Dockerfile` — multi-stage Bun build, static SPA served from the same Hono server
- `.dockerignore` — `node_modules`, `.env`, `.env.local`, `eval/results.md` (redeployed fresh), `.git`
- `fly.toml` — region `cdg` (Paris) or `ams` (Amsterdam) for EU reviewer latency, 1 VM, 512MB, auto_start_machines + auto_stop_machines for cost

**`Dockerfile`:**

Multi-stage: build stage installs all deps + runs `vite build`; final stage installs prod-only deps and copies the built output. Keeps the runtime image small and fast.

```dockerfile
# Build stage: all deps, runs vite build
FROM oven/bun:1.1 AS build
WORKDIR /app
# COPY both lockfile names so whichever one your bun init wrote gets picked up
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build   # vite build → dist/

# Runtime stage: prod-only deps + built artifacts + server source
FROM oven/bun:1.1-slim
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --production --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
```

The `bun.lock*` + `bun.lockb*` double glob handles both lockfile formats — whichever `bun init` produced for you gets copied, the other silently skips. No slow-install surprise.

**`package.json` scripts** (needed for this to work):

```json
{
  "scripts": {
    "dev": "bun run --hot src/server.ts",
    "build": "vite build",
    "eval": "bun run eval/run.ts",
    "test": "bun test"
  }
}
```

**`fly.toml`:**

```toml
app = "bizzy-enrichment"
primary_region = "cdg"

[build]

[env]
  NODE_ENV = "production"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = false
  min_machines_running = 1   # keep one warm so reviewers never hit cold start

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

**Why `min_machines_running = 1`:** worst-case cold path (Bun startup + homepage fetch + linked pages + Tavily + Google News + Claude) adds up to 22-34s, which trips the 30s global request timeout on first-after-idle requests. Reviewer hits the URL, gets a spurious timeout, assumes it's broken. Keeping one machine warm costs ~€0.40/month and removes the entire class of "it timed out once" perception bugs. Auto-stop stays off so the warm machine actually stays warm.

**Demo key (shared-secret + password prompt):**

Public URL without auth = anyone can burn your Anthropic/Tavily budget. Cheap mitigation: shared secret in a header + per-IP rate limit + password prompt UI so a reviewer can unlock the demo in one step.

Server side (`src/server.ts` middleware):

**Fail-fast boot guard** — put this at the very top of `src/server.ts`, before any route handlers, so a misconfigured deploy refuses to start instead of silently running with no auth:

```ts
const DEMO_KEY = Bun.env.DEMO_KEY;
if (Bun.env.NODE_ENV === "production" && (!DEMO_KEY || DEMO_KEY.length < 8)) {
  throw new Error("DEMO_KEY must be set (non-empty, ≥8 chars) in production");
}
```

**Auth middleware** — strict undefined check so empty string cannot bypass:

```ts
app.use("/api/*", async (c, next) => {
  // Local dev: DEMO_KEY env var absent → open access. Set DEMO_KEY to enable auth.
  if (DEMO_KEY === undefined) return next();
  const provided = c.req.header("X-Demo-Key");
  if (provided !== DEMO_KEY) return c.json({ error: "unauthorized" }, 401);
  return next();
});
```

**Per-IP rate limit** (in-memory, resets on restart — acceptable for demo):

```ts
const hits = new Map<string, { count: number; windowStart: number }>();
function extractIp(c: Context): string {
  const fly = c.req.header("Fly-Client-IP");
  if (fly) return fly;
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();  // chain → first (original client)
  return "unknown";
}
app.use("/api/enrich", async (c, next) => {
  const ip = extractIp(c);
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.windowStart > 3600_000) hits.set(ip, { count: 1, windowStart: now });
  else if (rec.count >= 20) return c.json({ error: "rate_limited" }, 429);
  else rec.count++;
  return next();
});
```

Client side (`src/ui/App.tsx`):

```tsx
const DEMO_KEY_STORAGE = "bizzy-demo-key";
const [demoKey, setDemoKey] = useState<string | null>(
  () => localStorage.getItem(DEMO_KEY_STORAGE)
);

// If no key in storage, show a full-screen prompt before the main UI renders
if (!demoKey) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
      <form onSubmit={(e) => {
        e.preventDefault();
        const v = (e.currentTarget.elements.namedItem("key") as HTMLInputElement).value;
        localStorage.setItem(DEMO_KEY_STORAGE, v);
        setDemoKey(v);
      }}>
        <h1>Bizzy Enrichment Demo</h1>
        <p>Enter the demo key (shared with the reviewer over email)</p>
        <input name="key" type="password" autoFocus required />
        <button type="submit">Unlock</button>
      </form>
    </div>
  );
}

// Main UI: attach header on every fetch
async function enrich(url: string) {
  const res = await fetch("/api/enrich", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Demo-Key": demoKey,
    },
    body: JSON.stringify({ url }),
  });
  if (res.status === 401) {
    localStorage.removeItem(DEMO_KEY_STORAGE);
    setDemoKey(null);
    return;
  }
  // ...
}
```

In the submission email/README, include the demo URL + the demo key. Reviewer pastes once, the browser remembers it.

**Deploy:**

```bash
fly launch --no-deploy    # generates fly.toml, adjust above
fly secrets set ANTHROPIC_API_KEY=sk-ant-... TAVILY_API_KEY=tvly-... ANTHROPIC_MODEL=claude-sonnet-4-5-20250929 CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... DEMO_KEY=$(openssl rand -hex 16)
fly secrets list   # verify, note DEMO_KEY value for the README
fly deploy
```

**One thing to verify in testing:** the SSRF guard's `dns.promises.lookup` must resolve public hostnames from within the Fly container. Should work out of the box (Fly provides DNS), but test before committing the deploy URL to the README — if DNS is slow, the first request to a new domain may time out.

**Checkpoint:** `curl https://bizzy-enrichment.fly.dev/health` returns `ok`. Browser enrichment of `stripe.com` from the deployed URL works in <15s.

---

## Phase 7 — README

Cover in this order (the order matters — #2 is deliberately early so the reviewer reads it before they've decided anything):

1. **What it does** — 3 sentences. Just the product claim. No scope talk yet.
2. **Live demo** — link to Fly.io URL + demo key (shared with reviewer in the submission email, but also included here for re-reference) + one example to try (`stripe.com`).
3. **On scope** — one paragraph owning the decision to exceed the brief's suggested hour, what was added (eval + deploy) and why, and what was explicitly held off (streaming, Playwright fallback, paid contacts). The brief invited pushback on framing — this is the pushback, defended. Suggested framing:

   > *"The brief suggested 1 hour. I took roughly 3. Here's why you should still read it: in an hour I can show you I can ship code — that's a low ceiling. In 3 hours I can show you how I'd actually build a piece of this at Bizzy scale — which is the question you're actually hiring for. I made two deliberate expansions beyond a minimal prototype: an eval harness (because 'how confident are you?' is the question you said matters most in the brief, and evals are the shipped answer), and a live Fly.io deployment (so you can hit the thing in 10 seconds). I held scope firmly against four other tempting additions — they're listed in DESIGN.md's 'considered and rejected' section. That scope discipline is what I'd bring to the job."*

4. **How to run locally** — `.env` setup, `bun install`, `bun run dev`.
5. **How to run the eval** — `bun run eval` (against localhost) or `EVAL_TARGET=https://bizzy-demo.fly.dev EVAL_DEMO_KEY=<key> bun run eval` (against deploy).
6. **Where it's weak** — contacts for SMEs, no caching, English-only. (JS-heavy sites are handled by the Cloudflare Browser Run fallback when CF credentials are configured; without them, those sites degrade to Cheerio output.)
7. **What's next** — Proxycurl/PDL/Cognism for contacts, streaming output, expand eval to 50+ companies, eager Cloudflare prefetch for known-JS-heavy domains.
8. **What I deliberately didn't build, and why** — one paragraph explaining the LinkedIn omission: *"Direct LinkedIn scraping is the obvious source for contacts but a dead end at any scale — HTTP 999, authwalls, TLS fingerprinting, and legal exposure that survived hiQ v LinkedIn. The production path is a paid provider (Proxycurl, PDL, or Cognism for EU). In v0 I chose to extract only from the company's own pages and document the gap rather than ship a flaky LinkedIn scraper that would feel dishonest."*

---

## Things to have ready before you start

- Anthropic API key with Sonnet access.
- Tavily API key (1k free searches/month; signup takes ~2 min at tavily.com).
- Cloudflare account + API token with Browser Rendering scope (free tier covers demo usage). Token needs `Account.Browser Rendering` permission. Required for the JS-only fallback; without it, Webflow/Framer sites degrade to empty Cheerio output.
- Google News RSS needs no key — verify the URL pattern works from curl before you start: `curl -s 'https://news.google.com/rss/search?q=stripe&hl=en-US&gl=US&ceid=US:en' | head -c 500`.
- Bun 1.1+ installed (`bun --version`).
- A shortlist of 4 test URLs: one big (`stripe.com` — Cheerio path), one mid (`framer.com` — should trigger CF fallback), one small-Belgian (`.be` TLD), one deliberately JS-only (`linear.app` or `vercel.com` — verifies the fallback works).

---

## Honest list of things that will probably break

- A Belgian SME will often return 0 contacts and 0–1 news articles even with Google News RSS. Expected. Make sure the UI shows this honestly rather than padding.
- Cloudflare Browser Run cold starts can hit ~10s on first call to a region. Subsequent calls within the same minute are fast. The fallback's 15s timeout covers this; on timeout, the empty Cheerio result is returned.
- Cloudflare's free tier rate limits (typically 10 req/min on Browser Rendering free) can throttle if a reviewer mass-runs the eval against deployed. Eval already paces 1s between calls, but 10 companies × 1 CF call when triggered = potentially 10 CF calls ≈ at the limit. Keep an eye on `debug.failures` for `cloudflare_rate_limited`.
- Tavily sometimes returns wrong-company results for generic names. The citation validator catches some of this but not all.
- Claude occasionally returns a citation that points to a chunk which doesn't literally contain the entity (especially CEO names). The containment validator catches this.
- Google News RSS redirect resolution occasionally times out or 302s back to Google. Fall back to the redirect URL if the final URL is still a `news.google.com` host — flag it in `debug.failures` rather than hide it.
- TLD-based locale is wrong for `.be` Wallonia companies if you only query `nl-BE`. The dual `nl-BE` + `fr-BE` query in Phase 2 is the cheap fix; dedup takes care of overlap.
