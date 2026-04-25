import type { FetchedDoc, NormalizedCitation } from "./types";

// Typographic drift between LLM output and source spans, normalized in three passes:
//   1) Unusual whitespace (NBSP, en/em quad, line/paragraph sep, narrow no-break,
//      medium math space, ideographic space, BOM) → regular space
//   2) Zero-width space / non-joiner / joiner → strip entirely
//   3) Smart quotes and en/em/minus dashes → ASCII equivalents
// Encoded with explicit \u escapes so the formatter can't collapse adjacent codepoints
// into invalid character-class ranges.
const UNUSUAL_WHITESPACE = /[\u00A0\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/g;
const ZERO_WIDTH = /[\u200B-\u200D]/g;
const SINGLE_QUOTES = /[\u2018-\u201B]/g;
const DOUBLE_QUOTES = /[\u201C-\u201F]/g;
const DASHES = /[\u2013\u2014\u2212]/g;

export function normalizeQuote(s: string): string {
  return s
    .replace(UNUSUAL_WHITESPACE, " ")
    .replace(ZERO_WIDTH, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface ReconcileResult {
  source_url?: string;
  confidence: "verified" | "inferred";
  /** Which signal verified this — useful for debugging "why is everything inferred?" */
  via?: "citation" | "doc_substring";
}

/**
 * Two-stage grounding:
 *   1. API-level: was the quote returned in Claude's `cited_text` array? (strongest signal)
 *   2. Doc-substring: does the quote appear verbatim in any source document we sent? (still real grounding)
 *
 * Both yield `confidence: "verified"` — they're equivalent guarantees against fabrication.
 * The Citations API is the preferred signal but doesn't always fire (Claude may answer in
 * structured JSON without engaging the citation pathway), so we fall back to substring match
 * against the bundle to catch verbatim quotes the API didn't tag.
 */
export function reconcile(
  quote: string | undefined,
  citations: NormalizedCitation[],
  docs: FetchedDoc[] = [],
): ReconcileResult {
  if (!quote || quote.trim().length === 0) return { confidence: "inferred" };
  const q = normalizeQuote(quote);
  if (q.length < 4) return { confidence: "inferred" };

  // Stage 1: API-level citation hit
  const cited = citations.find((c) => {
    const t = normalizeQuote(c.cited_text);
    return t.includes(q) || q.includes(t);
  });
  if (cited) return { source_url: cited.source_url, confidence: "verified", via: "citation" };

  // Stage 2: doc-substring fallback — model didn't cite via API but the quote is a literal
  // substring of something we sent.
  const docHit = docs.find((d) => normalizeQuote(d.text).includes(q));
  if (docHit) {
    return { source_url: docHit.source_url, confidence: "verified", via: "doc_substring" };
  }

  return { confidence: "inferred" };
}
