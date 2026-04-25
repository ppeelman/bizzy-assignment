import Anthropic from "@anthropic-ai/sdk";
import type {
  EnrichmentClaims,
  FetchedDoc,
  FetchedDocType,
  NormalizedCitation,
} from "../core/types";
import { type LLMClient, LLMParseError, type LLMSynthesis } from "../enrich";
import { type Logger, silentLogger } from "./logger";

const SYSTEM_PROMPT = `You are Bizzy's enrichment engine. Sales reps use your output to decide who to email and what to say. Honesty over completeness — a missing field beats a fabricated one.

Rules:
1. Use ONLY the attached source documents. No outside knowledge.
2. For every factual field, include a "supporting_quote" copied verbatim from one document.
3. If the documents don't support a field, set value to null and omit supporting_quote.
4. Never invent contacts, news, or numbers. If unsure, leave it out.
5. "reasons" is your synthesis across sources — plain strings, no per-item quotes required.

You will be evaluated on: did every quoted value actually appear in the documents?`;

const SCHEMA_INSTRUCTIONS = `Produce a JSON object with this exact shape (no markdown fences, no commentary). Use null for any field the documents don't support.

{
  "summary": { "value": "1–2 sentence description of what the company does", "supporting_quote": "verbatim span from a document" },
  "industry": { "value": "primary industry/category", "supporting_quote": "verbatim span" },
  "reasons": ["short reason a rep should reach out", "another", "another"],
  "contacts": [
    { "name": { "value": "Full Name", "supporting_quote": "verbatim span containing the name" },
      "role": { "value": "Title", "supporting_quote": "verbatim span containing the role" },
      "why": "1 sentence on why this person is relevant" }
  ],
  "news": [
    { "title": { "value": "headline", "supporting_quote": "verbatim span" },
      "url": "source URL",
      "date": "ISO date if known" }
  ]
}

Constraints:
- Up to 3 contacts, up to 2 news items. Returning fewer is fine — return zero rather than fabricate.
- "supporting_quote" must be a substring of one of the attached documents. Whitespace and punctuation must match.
- Each contact's name must literally appear in its supporting_quote.
- Each news title must literally appear in its supporting_quote.
- "reasons" is short bullet phrases (≤140 chars each), 0–3 items.
- Respond with the JSON object only — no preamble, no trailing text.`;

const DOC_PRIORITY: Record<FetchedDocType, number> = {
  homepage: 0,
  about: 1,
  team: 2,
  tavily_news: 3,
  gnews: 4,
};

export interface AnthropicLLMConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  maxDocs?: number;
  maxCharsPerDoc?: number;
  logger?: Logger;
}

export class AnthropicLLMService implements LLMClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly maxDocs: number;
  private readonly maxCharsPerDoc: number;
  private readonly log: Logger;

  constructor(config: AnthropicLLMConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 2048;
    this.maxDocs = config.maxDocs ?? 8;
    this.maxCharsPerDoc = config.maxCharsPerDoc ?? 6000;
    this.log = config.logger ?? silentLogger;
  }

  async synthesize(docs: FetchedDoc[], signal?: AbortSignal): Promise<LLMSynthesis> {
    const capped = this.capDocuments(docs);
    const t0 = Date.now();
    this.log.debug({ docs: capped.length, model: this.model }, "calling Claude");

    const documentBlocks = capped.map((d) => ({
      type: "document" as const,
      source: { type: "text" as const, media_type: "text/plain" as const, data: d.text },
      title: d.source_url,
      citations: { enabled: true },
    }));

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [...documentBlocks, { type: "text", text: SCHEMA_INSTRUCTIONS }],
          },
        ],
      },
      signal ? { signal } : undefined,
    );

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    const rawText = textBlocks
      .map((b) => b.text)
      .join("\n")
      .trim();

    const citations: NormalizedCitation[] = [];
    for (const block of textBlocks) {
      for (const c of block.citations ?? []) {
        // Plain-text documents return char_location citations; other variants
        // (page_location for PDFs, web_search/search_result locations) don't apply
        // here — we only attach text-based documents to the request.
        if (c.type !== "char_location" || !c.cited_text) continue;
        const titleFromIdx = capped[c.document_index]?.source_url;
        citations.push({
          cited_text: c.cited_text,
          source_url: c.document_title ?? titleFromIdx ?? "unknown",
        });
      }
    }

    let claims: EnrichmentClaims;
    try {
      claims = this.extractJson(rawText);
    } catch {
      this.log.error({ rawText: rawText.slice(0, 200) }, "Claude JSON parse failed");
      throw new LLMParseError(rawText);
    }

    this.log.info(
      {
        elapsed_ms: Date.now() - t0,
        model: response.model,
        citations: citations.length,
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
      },
      "Claude responded",
    );
    return { claims, citations, modelUsed: response.model };
  }

  private capDocuments(docs: FetchedDoc[]): FetchedDoc[] {
    return [...docs]
      .sort((a, b) => DOC_PRIORITY[a.type] - DOC_PRIORITY[b.type])
      .slice(0, this.maxDocs)
      .map((d) => ({ ...d, text: d.text.slice(0, this.maxCharsPerDoc) }));
  }

  private extractJson(text: string): EnrichmentClaims {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("no_json_braces_found");
    return JSON.parse(text.slice(start, end + 1)) as EnrichmentClaims;
  }
}
