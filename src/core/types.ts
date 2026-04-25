export type Confidence = "verified" | "inferred" | "unknown";

export interface VerifiedField<T = string> {
  value: T | null;
  supporting_quote?: string;
  source_url?: string;
  confidence: Confidence;
}

export interface Contact {
  name: VerifiedField<string>;
  role: VerifiedField<string>;
  why: string;
}

export interface NewsItem {
  title: VerifiedField<string>;
  url: string;
  date?: string;
}

export interface EnrichmentEntity {
  summary: VerifiedField<string>;
  industry: VerifiedField<string>;
  reasons: string[];
  contacts: Contact[];
  news: NewsItem[];
}

export type FetchedDocType = "homepage" | "about" | "team" | "tavily_news" | "gnews";
export type FetcherKind = "cheerio" | "cloudflare" | "tavily" | "gnews";

export interface FetchedDoc {
  type: FetchedDocType;
  source_url: string;
  text: string;
  fetcher?: FetcherKind;
}

export interface NormalizedCitation {
  cited_text: string;
  source_url: string;
}

export interface Claim {
  value: string | null;
  supporting_quote?: string;
}

export interface EnrichmentClaims {
  summary?: Claim;
  industry?: Claim;
  reasons?: string[];
  contacts?: Array<{ name?: Claim; role?: Claim; why?: string }>;
  news?: Array<{ title?: Claim; url?: string; date?: string }>;
}

export interface SourceFailure {
  type: string;
  source_url?: string;
  error: string;
}

// --- Wire response shapes (HTTP) ---------------------------------------------

export interface EnrichmentMetadata {
  fetched_sources: Array<{ type: string; source_url: string; bytes: number; fetcher?: string }>;
  failures: SourceFailure[];
  citations_count: number;
  elapsed_ms: number;
  model: string;
}

export interface EnrichmentResponse extends EnrichmentEntity {
  _debug: EnrichmentMetadata;
}

export interface ErrorResponse {
  error: string;
  reason?: string;
  failures?: SourceFailure[];
}
