# Design & Approach — Bizzy URL Enrichment

**Author:** Philippe · **Role:** Sr Software Engineer assignment · **Date:** 2026-04-23

---

## TL;DR

Fetch real sources in parallel, hand them to Claude with the Citations API so every factual field ties back to a source span, post-validate entity claims against the cited text, label per-field confidence in the UI. When sources don't support a claim, return `null`, not a plausible lie. v0 proves the architecture on both extremes — well-documented US company and small Belgian SME — plus two expansions: an **eval harness** (the brief says "how confident are you?" is what matters most, an eval is the shipped answer) and a **Fly.io deployment** so you hit the running thing in 10 seconds.

---

## 1. Architecture

```
                              URL in
                                │
                                ▼
                  ┌─────────────────────────────┐
                  │   SSRF guard                │
                  │   reject non-http(s),       │
                  │   private IPs, weird ports  │
                  └──────────────┬──────────────┘
                                 │
                                 ▼
                  ┌─────────────────────────────┐
                  │   Homepage fetch             │  gates everything below
                  │   Cheerio first              │
                  │     ↳ if < 200 chars text:   │
                  │       Cloudflare Browser Run │  managed JS render
                  │       crawl endpoint         │  (real browser)
                  │   Extract company name:      │
                  │   og:site_name → <title>     │
                  │        → domain root         │
                  └──────────────┬──────────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
           /about + /team    Tavily          Google News RSS
           (Cheerio)         search          (locale-aware,
                                              nl-BE, fr-BE, ...)
                 │               │               │
                 └───────────────┼───────────────┘
                                 ▼
                    ┌───────────────────────┐
                    │   Document bundle     │  5–15 docs, each tagged
                    │                       │  {source_url, type, ts}
                    └───────────┬───────────┘
                                ▼
                ┌───────────────────────────────┐
                │   Claude (Citations API)      │
                │                               │
                │   Every verifiable field:     │
                │     { value, supporting_quote}│
                │                               │
                │   reasons[] is synthesized →  │
                │   `inferred` by construction  │
                └───────────────┬───────────────┘
                                ▼
                ┌───────────────────────────────┐
                │   Post-validator              │
                │   • entity in cited text?     │
                │       (else drop)             │
                │   • no citation? → `inferred` │
                │   • dedup, trim to ≤3 / ≤2    │
                └───────────────┬───────────────┘
                                ▼
                         JSON result
          { summary, industry, reasons,
            contacts: [{name, role, why, source_url, confidence}],
            news:     [{title, date, url, source_url, confidence}],
            _debug:    { fetched_sources, citations } }

LinkedIn intentionally NOT scraped in v0 — see §5.
```

**Why these components:**

- **Tavily + Google News RSS as siblings.** Tavily has citable snippets for synthesis fields. Google News RSS is free, locale-aware via TLD, picks up EU press (De Tijd, L'Echo) that Tavily misses. Short RSS snippets feed the `news` field (title + url + date is all you need there). Production swaps RSS for a contracted news API.
- **Cheerio first, Cloudflare Browser Run as JS-only fallback.** Cheerio handles 80%+ of sites in <200ms. When it returns thin text (Webflow, Framer, JS-heavy Next.js marketing), we call Cloudflare's crawl endpoint — managed real-browser render, no headless dep in our container, decent anti-bot fingerprint. Adds ~2-5s only when needed. Replaces what would have been a Playwright fallback.
- **Citations API over self-hosted RAG.** No citation → drop the field. Citation present is necessary but not sufficient (Layer 2 catches the rest).
- **`{value, supporting_quote}` over tool_use-with-schema.** Citations attach to content-block spans, not JSON fields. Matching `supporting_quote` against `cited_text` gives per-field grounding cleanly.

---

## 2. Working for *any* URL

| Company | What the fetcher returns | What ships |
|---------|--------------------------|------------|
| **Microsoft** | Rich homepage, Wikipedia, dozens of news | Tight summary, verified CEO, 2–3 contacts from company pages, 2 real news, 3 sharp reasons — all high confidence |
| **Mid-market EU SaaS** | Decent homepage, some English news, locale press via GNews | Homepage-driven summary + industry, 1–2 contacts, 1–2 news, softer reasons |
| **10-person Gent SME** (`.be`) | WordPress site, zero Tavily results, 1–3 GNews hits `hl=nl-BE`, founder mentioned once | Short summary, 1 contact (founder), `news: [0..2]` from local press |
| **Unreachable site** | Fetch fails | `error: "source_fetch_failed"` with the reason. No LLM call. |

Graceful degradation = **never inventing what sources don't support**. A rep's trust breaks the first time the tool emails "Sarah Chen, CEO" at a 5-person Belgian startup whose actual founder is Jan Peeters. Fewer fields with honest labels beats filling every slot.

---

## 3. Verified vs. inferred — the hallucination problem

Three layers, in order:

**Layer 1 — Grounding at the API level.** Claude's citations carry `cited_text` (literal span from a source doc) and `document_title` (I set it to the source URL). The validator matches each field's `supporting_quote` against returned `cited_text`. Pure content match, no span math. **No citation → drop.**

**Layer 2 — Entity containment.** Claude can cite "our leadership team" and still claim "CEO: Sarah Chen" from it. For every entity (person, date, dollar amount), string-contain against the cited chunk. If the entity isn't literally in the citation, drop the field.

**Layer 3 — Source quality gate.** Before the LLM call: final fetched URL must match the input domain, page must return ≥200 chars of meaningful text, at least one source must have succeeded. Otherwise skip Claude entirely and return an error.

**In the output:** every field carries `confidence: "verified" | "inferred" | "unknown"` + a `source_url` when verified. Reps trust `verified`, double-check `inferred`.

**To be 100% sure (deferred):** 50–100 company eval for regressions, rep "this is wrong" feedback channel, entity-resolution pass against Proxycurl / PDL / Cognism. Direct LinkedIn stays off the table — 9xx responses, TLS fingerprinting, legal exposure that survived hiQ v LinkedIn 2022.

---

## 4. Scope — v0 vs. deferred

v0 proves the architecture end-to-end, plus two deliberate expansions: an **eval harness** (numbers, not claims) and a **Fly.io deployment** (no cloning required).

**Phases:** SSRF + homepage + name extractor → parallel fetchers + bundler → Claude Citations + reconciliation + validator → 3 smoke tests → minimal UI → eval (10 companies) → Fly.io deploy → README.

**Cut, deliberately:**

- **Contacts from LinkedIn** — dead end at any scale (HTTP 999, authwalls, TLS fingerprinting, legal grey zone). Production uses Proxycurl / PDL / Cognism; integrating one breaks the "reproducible without a paid account" rule. v0 extracts from company's own pages. Expect 0–2 contacts on SMEs.
- **No caching** — production caches by (URL + source-version-hash); v0 hits live sources.
- **Demo-only auth** — the Fly.io URL uses a shared-secret header (`X-Demo-Key`) unlocked via password prompt + localStorage, plus 20/hour per-IP rate limit. Stops strangers burning the Anthropic budget.
- **No Playwright, no streaming, tests limited to 3 smoke tests** on the riskiest paths (SSRF, validator containment, citation reconciliation — where silent failure is worst).
- **English-only prompts** — GNews partially compensates with locale queries, LLM still reasons in English.

**v0.1+:** team-page `name + title` extractor, streaming output, 50-company eval, paid contacts provider.

---

## 5. Off-the-shelf LLM vs. combined

- **LLM alone** — one call, fast, zero infra. But for an unseen URL (Belgian SME with no Wikipedia) the model *will* fabricate. Knowledge cutoff kills news. Non-starter.
- **LLM + search** — grounds news, still needs scraping beyond snippets. Citations API treats search results as documents — right combination.
- **LLM + scraping** — authoritative on the company's own claims, fragile on JS-heavy sites and blocked user agents, nothing external.
- **LLM + structured APIs (Apollo, Clearbit, PDL)** — clean data, best for contacts. Costs per enrichment, contracts, *weak EU SME coverage* — the exact segment the brief flagged.
- **Latency — the fifth dimension.** LLM-only ~1–2s. Scrape + search + Citations ~8–12s. The brief promises "seconds" — production needs streaming and aggressive caching. Prototype skips streaming; honest gap.

**Production ships all four, composed.** Scraping → company facts. Search → news. Structured APIs → contacts at scale. LLM → summary + reasons synthesis. Citations grounds quotable fields; `reasons` is `inferred` by construction.

**v0 ships** scrape + search + LLM with Citations. Paid APIs deferred because (a) integration overhead, (b) cost, (c) their weakest segment (EU SMEs) is exactly the segment this architecture handles without them.

---

## Premises

1. **Explicit "I don't know" beats plausible fabrication.** Structural, not prompt-engineered.
2. **"Three contacts / two news articles" is worth softening** to `[0..3]` / `[0..2]`. Exact counts create hallucination pressure on SMEs.
3. **Right-sized scope beats exhaustive scope.** Proving the architecture on both extremes is more informative than v1 with every fallback wired up. Deferred work is named, not hidden.

---

## Known weaknesses

- Contacts thin for SMEs (v0 extracts from own pages only). Production needs a paid provider.
- Cloudflare Browser Run handles JS-heavy sites, but adds a Cloudflare API token to `.env`. Reviewers cloning to run locally need a CF account (free tier covers demo usage). Tradeoff for solving the Webflow/Framer empty-text case.
- No caching → repeated enrichments hit live sources.
- English-only prompting — mediocre on Dutch / French / German copy.
- TLD-based locale is crude (`.be → nl-BE` misses Wallonia). Production: language detector on the homepage.
- Google News RSS is an unofficial endpoint — could break. Production: contracted news API.
- Eval at v0 scale (10 companies) is too small for meaningful precision/recall. Production wants 50–100+.
- No concurrent-request dedup (double-click runs two pipelines). Fine for a prototype.

---

## Production Bizzy — different from this prototype

- **Async + cached pipeline.** Enrichment is a job, not a request. Workers pull from a queue. Cache by (URL + source-version-hash), 24h–7d TTL depending on field.
- **Pre-enrichment for hot accounts.** Nightly refresh of companies touched in the last 30 days. Live is the cold-start path.
- **Confidence surface in the UI** — per-field source chips, click-through, a "verify" button that forces re-fetch.
- **Feedback loop.** One-click "this is wrong" → flagged case → eval set → next iteration.
- **Cost controls.** Tavily + Claude is €0.02–0.05 / enrichment; at thousands/day that's real money. Per-tenant budget guards, warmer cache, Haiku on summary with Sonnet/Opus only on contacts.
- **Eval on every prompt/model change.** Catches regressions before shipping.
- **Multilingual prompts** — rep's language, company's locale.
- **Contracted news API** replaces unofficial RSS. Locale-aware query stays.
- **Contacts tier** — Proxycurl for LinkedIn-sourced profiles (~€0.01–0.03 each), Cognism for EU SME coverage, PDL for disambiguation. Direct LinkedIn stays off the table at any scale.
