import { describe, expect, test } from "bun:test";
import type { EnrichmentClaims, NormalizedCitation } from "../src/core/types";
import { validate } from "../src/core/validate";

describe("validate", () => {
  test("drops contacts whose name is not in the supporting_quote", () => {
    const citations: NormalizedCitation[] = [
      { cited_text: "Founded by Jan Peeters in 2015", source_url: "https://acme.be/about" },
      { cited_text: "our leadership team", source_url: "https://acme.be/team" },
    ];
    const raw: EnrichmentClaims = {
      summary: { value: null },
      industry: { value: null },
      reasons: [],
      contacts: [
        {
          name: { value: "Jan Peeters", supporting_quote: "Founded by Jan Peeters in 2015" },
          role: { value: "Founder", supporting_quote: "Founded by Jan Peeters in 2015" },
          why: "founder",
        },
        {
          name: { value: "Sarah Chen", supporting_quote: "our leadership team" },
          role: { value: "CEO", supporting_quote: "our leadership team" },
          why: "hallucinated",
        },
      ],
      news: [],
    };
    const out = validate(raw, citations);
    expect(out.contacts).toHaveLength(1);
    expect(out.contacts[0]?.name.value).toBe("Jan Peeters");
    expect(out.contacts[0]?.name.confidence).toBe("verified");
  });

  test("drops contacts whose supporting_quote isn't in any citation", () => {
    const citations: NormalizedCitation[] = [
      { cited_text: "Acme builds widgets", source_url: "https://acme.be" },
    ];
    const raw: EnrichmentClaims = {
      reasons: [],
      contacts: [
        {
          name: { value: "Ghost Person", supporting_quote: "made-up text" },
          role: { value: "CEO", supporting_quote: "made-up text" },
          why: "x",
        },
      ],
      news: [],
    };
    const out = validate(raw, citations);
    expect(out.contacts).toHaveLength(0);
  });

  test("dedups contacts by normalized name", () => {
    const citations: NormalizedCitation[] = [
      { cited_text: "Jan Peeters, founder", source_url: "https://x" },
    ];
    const raw: EnrichmentClaims = {
      reasons: [],
      contacts: [
        {
          name: { value: "Jan Peeters", supporting_quote: "Jan Peeters, founder" },
          role: { value: "Founder", supporting_quote: "Jan Peeters, founder" },
          why: "x",
        },
        {
          name: { value: "  jan peeters ", supporting_quote: "Jan Peeters, founder" },
          role: { value: "CEO", supporting_quote: "Jan Peeters, founder" },
          why: "y",
        },
      ],
      news: [],
    };
    const out = validate(raw, citations);
    expect(out.contacts).toHaveLength(1);
  });

  test("drops news whose title isn't in the citation", () => {
    const citations: NormalizedCitation[] = [
      { cited_text: "Acme raises Series B from Index Ventures", source_url: "https://tech.eu/x" },
    ];
    const raw: EnrichmentClaims = {
      reasons: [],
      contacts: [],
      news: [
        {
          title: {
            value: "Acme raises Series B",
            supporting_quote: "Acme raises Series B from Index Ventures",
          },
          url: "https://tech.eu/x",
          date: "2026-04-01",
        },
        {
          title: { value: "Made-up headline", supporting_quote: "totally invented" },
          url: "https://nope.example/y",
        },
      ],
    };
    const out = validate(raw, citations);
    expect(out.news).toHaveLength(1);
    expect(out.news[0]?.title.value).toBe("Acme raises Series B");
  });

  test("caps reasons at 3", () => {
    const raw: EnrichmentClaims = {
      reasons: ["a", "b", "c", "d", "e"],
      contacts: [],
      news: [],
    };
    const out = validate(raw, []);
    expect(out.reasons).toHaveLength(3);
  });

  test("null fields → unknown confidence", () => {
    const raw: EnrichmentClaims = {
      summary: { value: null },
      industry: { value: null },
      reasons: [],
      contacts: [],
      news: [],
    };
    const out = validate(raw, []);
    expect(out.summary.confidence).toBe("unknown");
    expect(out.industry.confidence).toBe("unknown");
    expect(out.summary.value).toBeNull();
  });

  test("drops news with non-http(s) url even when title is grounded (LLM trust boundary)", () => {
    const docs = [
      {
        type: "tavily_news" as const,
        source_url: "https://example.com/x",
        text: "Acme launches new product",
      },
    ];
    const raw: EnrichmentClaims = {
      reasons: [],
      contacts: [],
      news: [
        {
          title: {
            value: "Acme launches new product",
            supporting_quote: "Acme launches new product",
          },
          // Prompt-injected URL — would be a clickjack target if rendered.
          url: "javascript:alert(1)",
        },
        {
          title: {
            value: "Acme launches new product",
            supporting_quote: "Acme launches new product",
          },
          url: "data:text/html,<script>alert(1)</script>",
        },
        {
          title: {
            value: "Acme launches new product",
            supporting_quote: "Acme launches new product",
          },
          url: "https://example.com/x",
        },
      ],
    };
    const out = validate(raw, [], docs);
    expect(out.news).toHaveLength(1);
    expect(out.news[0]?.url).toBe("https://example.com/x");
  });

  test("verifies via doc-substring fallback when API citations are empty (the Microsoft case)", () => {
    const docs = [
      {
        type: "tavily_news" as const,
        source_url: "https://reuters.example/x",
        text: "Microsoft announces $80B AI infrastructure investment for 2026 — Reuters",
      },
    ];
    const raw: EnrichmentClaims = {
      summary: { value: null },
      industry: { value: null },
      reasons: [],
      contacts: [],
      news: [
        {
          title: {
            value: "Microsoft announces $80B AI infrastructure investment for 2026",
            supporting_quote:
              "Microsoft announces $80B AI infrastructure investment for 2026 — Reuters",
          },
          url: "https://reuters.example/x",
        },
      ],
    };
    // No API citations returned, but quote is verbatim in the doc.
    const out = validate(raw, [], docs);
    expect(out.news).toHaveLength(1);
    expect(out.news[0]?.title.confidence).toBe("verified");
    expect(out.news[0]?.title.source_url).toBe("https://reuters.example/x");
  });
});
