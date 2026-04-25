import normalizeUrlLib from "normalize-url";
import { normalizeQuote, reconcile } from "./reconcile";
import type {
  Claim,
  Contact,
  EnrichmentClaims,
  EnrichmentEntity,
  FetchedDoc,
  NewsItem,
  NormalizedCitation,
  VerifiedField,
} from "./types";

function buildField<T = string>(
  raw: Claim | undefined,
  citations: NormalizedCitation[],
  docs: FetchedDoc[],
): VerifiedField<T> {
  if (
    !raw ||
    raw.value === null ||
    raw.value === undefined ||
    (typeof raw.value === "string" && raw.value.trim() === "")
  ) {
    return { value: null, confidence: "unknown" };
  }
  const { via: _via, ...grounding } = reconcile(raw.supporting_quote, citations, docs);
  return {
    value: raw.value as T,
    supporting_quote: raw.supporting_quote,
    ...grounding,
  };
}

function entityContained(entity: string, quote: string | undefined): boolean {
  if (!quote) return false;
  const e = normalizeQuote(entity);
  if (e.length < 2) return false;
  const q = normalizeQuote(quote);
  return q.includes(e);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeUrl(url: string): string {
  try {
    return normalizeUrlLib(url, {
      stripWWW: true,
      stripHash: true,
      removeTrailingSlash: true,
      removeQueryParameters: [/^utm_/i, "ref", "fbclid"],
    });
  } catch {
    return url;
  }
}

/**
 * LLM trust boundary: a news URL the model emits gets rendered as <a href> in the
 * UI, so anything other than http(s) (e.g. javascript:, data:) is a clickjack/XSS
 * risk if a malicious source doc prompt-injects the model.
 */
function isSafeWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function validate(
  claims: EnrichmentClaims,
  citations: NormalizedCitation[],
  docs: FetchedDoc[] = [],
): EnrichmentEntity {
  const summary = buildField(claims.summary, citations, docs);
  const industry = buildField(claims.industry, citations, docs);

  const reasons = (claims.reasons ?? [])
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .map((r) => r.trim().slice(0, 200))
    .slice(0, 3);

  const contacts: Contact[] = [];
  const seenContact = new Set<string>();
  for (const c of claims.contacts ?? []) {
    if (!c?.name?.value || !c?.role?.value) continue;
    const nameField = buildField<string>(c.name, citations, docs);
    if (nameField.confidence !== "verified") continue;
    if (!entityContained(c.name.value, c.name.supporting_quote)) continue;

    const roleField = buildField<string>(c.role, citations, docs);
    const why = typeof c.why === "string" ? c.why.trim().slice(0, 280) : "";

    const key = normalizeName(c.name.value);
    if (seenContact.has(key)) continue;
    seenContact.add(key);

    contacts.push({ name: nameField, role: roleField, why });
    if (contacts.length >= 3) break;
  }

  const news: NewsItem[] = [];
  const seenNews = new Set<string>();
  for (const n of claims.news ?? []) {
    if (!n?.title?.value || !n?.url) continue;
    if (!isSafeWebUrl(n.url)) continue; // LLM trust boundary: drop any non-http(s) URL
    const titleField = buildField<string>(n.title, citations, docs);
    if (titleField.confidence !== "verified") continue;
    if (!entityContained(n.title.value, n.title.supporting_quote)) continue;

    const key = normalizeUrl(n.url);
    if (seenNews.has(key)) continue;
    seenNews.add(key);

    news.push({
      title: titleField,
      url: n.url,
      date: typeof n.date === "string" ? n.date : undefined,
    });
    if (news.length >= 2) break;
  }

  return { summary, industry, reasons, contacts, news };
}
