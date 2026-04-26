# Design & Approach — Bizzy URL Enrichment

**Author:** Philippe · **Date:** 2026-04-23

---

## TL;DR

We fetch real sources in parallel and hand them to Claude using the **Citations API**. Every factual field has to point back to a verbatim quote from one of those sources. A post-validator then checks that the named person, date, or amount actually appears in the quote. If the sources don't support a claim, the field comes back as `null` instead of a plausible-sounding guess. v0 covers both ends of the size spectrum (Microsoft and a small Belgian SME) and adds two deliberate extras: an **eval harness** so the confidence claims are backed by numbers, and a **Fly.io deploy** so a reviewer can try it in about 10 seconds.

---

## 1. Architecture — input URL → output JSON

```
   URL → SSRF guard → Homepage (Cheerio, CF /content fallback)
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        /about + /team   Tavily     Google News RSS
              │             │             │
              └─────────────┼─────────────┘
                            ▼
                    Document bundle
                            ▼
                  Claude (Citations API)
                            ▼
                      Post-validator
                            ▼
                       JSON result
```

**Why each component:**

- **Cheerio first, Cloudflare Browser Rendering `/content` as fallback.** Cheerio is fast (<200ms) and works on most sites. JS-heavy sites (Webflow, Framer) return almost no text — for those we call Cloudflare's `/browser-rendering/content` endpoint, which renders the page in a real headless Chromium and returns the post-JS HTML (~2–5s). We use `/content` rather than `/crawl` because we only need the homepage rendered: linked-page discovery (`/about`, `/team`) is done by walking the homepage's `<a href>` tags ourselves and re-fetching with Cheerio, which is cheaper and more targeted than a generic crawl. `/crawl` is also async/job-based, which doesn't fit a single-request pipeline. Both paths follow redirects step by step and re-check each hop against the SSRF guard.
- **Tavily + Google News RSS together.** Tavily gives short snippets we can cite. Google News RSS is free and locale-aware, so it picks up Belgian press (De Tijd, L'Echo) that Tavily often misses. RSS only needs to give us a title, url, and date for the `news` field.
- **Citations API, with a substring fallback.** Best case: Claude attaches a `cited_text` span to each fact, and we match the model's `supporting_quote` to that span. In practice the model sometimes skips the citation path when answering in JSON (we saw this on `microsoft.com`: 12 docs, 0 citations). When that happens we check whether the `supporting_quote` appears verbatim in any document we sent. Same guarantee, different route. If neither works, the field is marked `inferred` and dropped.
- **`{value, supporting_quote}` instead of a tool-use schema.** Citations attach to text spans, not JSON fields. Matching by content (not by position) survives small drift in whitespace, quotes, and case.

**Cost note.** Tavily and Cloudflare Browser Rendering both run on their free tiers, which is enough for the demo and the eval. For Claude I bought some Anthropic credits; Sonnet on a typical enrichment is a few cents per call.

---

## 2. Working for *any* URL — Microsoft to a Belgian 5-person shop

| Company | What sources return | What ships |
|---------|--------------------|------------|
| **Microsoft** | Rich homepage, Wikipedia, dozens of news | Tight summary, verified CEO, 2–3 contacts, 2 real news, sharp reasons — all `verified` |
| **Mid-market EU SaaS** | Decent homepage, some English news, locale press via GNews | Homepage-driven summary, 1–2 contacts, 1–2 news, softer reasons |
| **10-person Gent SME** (`.be`) | WordPress site, 0 Tavily hits, 1–3 GNews items via `nl-BE`+`fr-BE`, founder mentioned once | Short summary, 1 contact (founder), `news: [0..2]` from local press |
| **Unreachable site** | Fetch fails | `error: "source_fetch_failed"`. No LLM call. |

The same pipeline runs for every size of company because the grounding rules are structural, not tuned per case. The validator that drops a hallucinated CEO for a 5-person Gent startup also drops a fabricated VP-Sales for Microsoft. **Fewer fields with honest labels is better than filling every slot with confident guesses.** A sales rep stops trusting the tool the first time it emails the wrong person.

---

## 3. Verified vs. inferred — the hallucination problem

We use four layers. Any one of them is enough on its own to drop a fabricated claim:

1. **Two-stage grounding.** First we try to match the model's `supporting_quote` against a `cited_text` span returned by the Citations API. If the API returned no citations, we fall back to checking whether the `supporting_quote` appears verbatim in any of the documents we sent. If either match works, the field is `verified`. If neither does, it's marked `inferred` and dropped.
2. **Entity containment.** Claude can cite a span like *"our leadership team"* and still attach a name like *"CEO: Sarah Chen"* to it. For each contact's `name` and each news item's `title`, we check that the value actually appears as a substring of its supporting quote. If it doesn't, the contact or news item is dropped. (We apply this to the two slots where a fabricated atom would do most damage to a sales rep — names and headlines — not to every field.)
3. **Source quality gate.** Before we call the model, the homepage has to come back with at least 100 characters of text, and the redirect chain has to stay on the input eTLD+1 (`tldts`-based same-site check on every hop, re-validated through the SSRF guard). If the homepage fetch fails or comes back thin, we skip Claude and return `source_fetch_failed`. The other fetchers (`/about`, `/team`, Tavily, GNews) are best-effort — their failures land in `_debug.failures` but don't abort the request.
4. **LLM-URL trust boundary.** Any URL that Claude emits in `news[].url` has to parse as `http(s):`. This blocks prompt-injected `javascript:` or `data:` URLs that would otherwise render as a clickable link in the UI.

Every field in the output has a `confidence` value of `verified`, `inferred`, or `unknown`, plus a `source_url` when it's verified. The UI shows this as a colored dot, a text label, and a clickable source link. Reps can trust `verified` fields and double-check `inferred` ones. Because the label is text and not just color, the signal still works in grayscale and for colorblind users.

---

## 4. Where I invested under a 1-hour-spirit cap

The brief asked how confident we are in the output. That question shaped every scope decision. Time went to anything that answers it directly:

**Invested:**
- **Citations + validator** — the grounding spine. Without it, nothing else matters.
- **Eval harness** with 7 companies across four tiers (big US, mid EU, small Belgian, deliberately obscure). Real numbers instead of claims.
- **Fly.io deploy** with a one-step password unlock so the reviewer can hit a URL instead of cloning the repo.
- **Smoke tests on the riskiest paths** (5 files, 40 cases): SSRF, validator containment, citation reconciliation, auth middleware, env validation. Not full coverage — just the failure modes that would otherwise ship a broken product silently.

**Cut, deliberately:**
- **LinkedIn contacts.** Direct LinkedIn scraping is a dead end at any scale: HTTP 999 responses, authwalls, TLS fingerprinting, and legal exposure since the hiQ ruling. Production would use Proxycurl, PDL, or Cognism, but adding one of those would break the "runs without a paid account" rule. v0 only extracts contacts from the company's own pages, so SMEs will often return 0–2 contacts.
- **No caching.** Production would cache by URL plus a source-version hash. v0 hits live sources every time.
- **No streaming.** Honest gap. End-to-end is 8–12 seconds; the brief promises "seconds", which production would hit with streaming output and aggressive caching.
- **No Playwright.** Cloudflare's Browser Rendering `/content` endpoint covers the JS-render case without us shipping a headless browser in the container.
- **English-only prompts.** Locale-aware Google News queries partly make up for it.

Everything we cut is named here, not hidden. That's the same instinct as labelling a field `inferred` instead of letting Claude make something up.

---

## 5. Off-the-shelf LLM vs. combined — the trade-off matrix

| Approach | Strength | Failure mode |
|----------|----------|--------------|
| **LLM alone** | One call, ~1–2s, no infra | On an unseen URL — say, a small Belgian SME with no Wikipedia page — the model will make things up. The knowledge cutoff also kills news. Non-starter. |
| **LLM + search** | Gives us news; works well with citations | Only sees what the search vendor indexed; misses everything else |
| **LLM + scraping** | Authoritative for what the company says about itself | Fragile on JS-heavy or bot-managed sites; gives us nothing about the outside world |
| **LLM + structured APIs** (Apollo, Clearbit, PDL) | Clean data, best option for contacts at scale | Costs money per enrichment, requires contracts, and EU SME coverage is weak — exactly the segment the brief flagged |

**Production would combine all four.** Scraping for company facts. Search for news. Structured APIs for contacts at scale. LLM for the summary and the reasons-to-reach-out synthesis. Citations grounds the quotable fields, and `reasons` stays `inferred` by design because it's a synthesis across multiple sources.

**v0 ships scrape + search + LLM with Citations.** The paid APIs were deferred because of integration overhead, cost, and the fact that their weakest segment — EU SMEs — is exactly the one this architecture already handles without them.

**One more dimension: latency.** LLM-only is about 1–2s. Scrape + search + Citations is about 8–12s. Production would need streaming output and a warm cache for hot accounts. The prototype has neither.

---

## 6. Tooling: built with gstack

I used [gstack](https://github.com/garybernhardt/gstack) as a planning and review harness before writing any code. The skills I leaned on:

- **`/office-hours`** — pressure-tested the framing of the problem before locking scope: whose trust actually matters, and what "confident" really means in a sales-rep workflow.
- **`/plan-ceo-review`** — challenged the scope ceiling. The eval harness and the Fly.io deploy both came out of this review, because both directly answer the central question the brief asked.
- **`/plan-eng-review`** — locked down the architecture: the order in which fetchers run, the document cap, how Citations reconciliation handles whitespace and smart-quote drift, the validator's entity-containment guarantee, and the four critical failure modes (XML parse, JSON extraction, SSRF on redirects, empty Cheerio output).
- **`/plan-design-review`** — shaped the confidence-system UI (dot, label, and source link, in a way that still works in grayscale and for colorblind users), the AI-slop blacklist (no purple gradients, no uniform border-radius, no system-ui as the primary font), and the empty-state copy that names the production path instead of just saying "no results".
- **Codex consult + adversarial review** — a second opinion on the Citations-grounding approach, plus an adversarial pass that surfaced the substring-fallback case (the `microsoft.com` 0-citations failure mode) before it shipped.

These plan-mode reviews caught issues that would otherwise have shown up mid-build. The build itself was then straight execution against `BUILD_PLAN.md`.

---

## Premises

1. **An explicit "I don't know" beats a plausible-sounding guess.** This is enforced by structure, not by prompt-engineering.
2. **The "three contacts / two news articles" target should be soft.** We allow `[0..3]` and `[0..2]` instead. Exact counts push the model to invent things to fill the slots, especially for SMEs.
3. **Right-sized scope beats exhaustive scope.** Both ends of the size spectrum ship, and everything we cut is named instead of hidden.

---

## Known weaknesses

- Contacts are thin for SMEs because we only extract from their own pages. Production would need a paid provider.
- Cloudflare's Browser Rendering `/content` endpoint needs a token in `.env` (free tier is enough). Anyone cloning the repo needs a Cloudflare account; without one, JS-only sites just return empty Cheerio output.
- Sites with strong bot management (Tesla, Apple, etc.) defeat both Cheerio and Cloudflare. The pipeline returns `source_fetch_failed` in those cases. Production would use a residential-proxy scraping API.
- Google News RSS is an unofficial endpoint and indexes less than the web UI. Small SMEs sometimes return 0 items even when the web UI shows hits.
- No caching, so repeated enrichments hit the live sources every time.
- Prompts are English-only. Locale detection by TLD is crude — `.be` defaults to `nl-BE`, which misses Wallonia, so we also query `fr-BE` for `.be` domains.
- 7 companies is too small for meaningful precision and recall. Production would want 50–100 or more.
- No deduplication of concurrent requests for the same URL. Fine for a prototype.
