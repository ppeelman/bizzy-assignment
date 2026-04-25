import type {
  EnrichmentClaims,
  EnrichmentEntity,
  EnrichmentMetadata,
  FetchedDoc,
  NormalizedCitation,
  SourceFailure,
} from "./core/types";
import { validate } from "./core/validate";
import { type Logger, silentLogger } from "./services/logger";

// --- Service contracts (used to inject I/O into the use case) ----------------

export interface SourceBundle {
  homepageUrl: string;
  companyName: string;
  docs: FetchedDoc[];
  failures: SourceFailure[];
}

export type SourcesResult =
  | { ok: true; bundle: SourceBundle }
  | { ok: false; code: SourceErrorCode; reason: string; failures: SourceFailure[] };

export type SourceErrorCode = "ssrf_rejected" | "source_fetch_failed";

export interface SourceProvider {
  fetchSources(rawUrl: string, signal?: AbortSignal): Promise<SourcesResult>;
}

export interface LLMSynthesis {
  claims: EnrichmentClaims;
  citations: NormalizedCitation[];
  modelUsed: string;
}

export interface LLMClient {
  synthesize(docs: FetchedDoc[], signal?: AbortSignal): Promise<LLMSynthesis>;
}

export class LLMParseError extends Error {
  readonly rawText: string;
  constructor(rawText: string) {
    super("claude_parse_failed");
    this.name = "LLMParseError";
    this.rawText = rawText;
  }
}

// --- Use case ----------------------------------------------------------------

export type EnrichErrorCode =
  | "ssrf_rejected"
  | "source_fetch_failed"
  | "claude_parse_failed"
  | "claude_failed"
  | "timeout"
  | "internal_error";

export interface EnrichmentFailure {
  code: EnrichErrorCode;
  reason?: string;
  failures?: SourceFailure[];
}

export type EnrichmentOutput =
  | { ok: true; entity: EnrichmentEntity; metadata: EnrichmentMetadata }
  | { ok: false; error: EnrichmentFailure };

export interface EnrichDeps {
  sourceProvider: SourceProvider;
  llmClient: LLMClient;
  logger?: Logger;
}

export async function enrichCompany(
  deps: EnrichDeps,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<EnrichmentOutput> {
  const log = deps.logger ?? silentLogger;
  const t0 = Date.now();
  log.info({ url: rawUrl }, "enrichment requested");

  const sources = await deps.sourceProvider.fetchSources(rawUrl, signal);
  if (!sources.ok) {
    log.warn(
      { url: rawUrl, code: sources.code, reason: sources.reason },
      "enrichment aborted at source stage",
    );
    return {
      ok: false,
      error: { code: sources.code, reason: sources.reason, failures: sources.failures },
    };
  }

  const { bundle } = sources;

  let synthesis: LLMSynthesis;
  try {
    synthesis = await deps.llmClient.synthesize(bundle.docs, signal);
  } catch (e) {
    if (e instanceof LLMParseError) {
      log.error({ url: rawUrl }, "Claude returned non-JSON output");
      return {
        ok: false,
        error: {
          code: "claude_parse_failed",
          reason: e.rawText.slice(0, 500),
          failures: bundle.failures,
        },
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error({ url: rawUrl, err: msg }, "Claude call failed");
    return { ok: false, error: { code: "claude_failed", reason: msg, failures: bundle.failures } };
  }

  if (synthesis.citations.length === 0) {
    log.warn(
      { url: rawUrl, output_chars: JSON.stringify(synthesis.claims).length },
      "Claude returned 0 API-level citations — relying on doc-substring fallback for grounding",
    );
  }

  const entity = validate(synthesis.claims, synthesis.citations, bundle.docs);
  const elapsed = Date.now() - t0;
  const metadata: EnrichmentMetadata = {
    fetched_sources: bundle.docs.map((d) => ({
      type: d.type,
      source_url: d.source_url,
      bytes: d.text.length,
      fetcher: d.fetcher,
    })),
    failures: bundle.failures,
    citations_count: synthesis.citations.length,
    elapsed_ms: elapsed,
    model: synthesis.modelUsed,
  };
  log.info(
    {
      url: rawUrl,
      elapsed_ms: elapsed,
      contacts: entity.contacts.length,
      news: entity.news.length,
      verified_summary: entity.summary.confidence === "verified",
    },
    "enrichment complete",
  );

  return { ok: true, entity, metadata };
}
