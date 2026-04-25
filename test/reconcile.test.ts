import { describe, expect, test } from "bun:test";
import { normalizeQuote, reconcile } from "../src/core/reconcile";

describe("reconcile", () => {
  test("quote present in a citation's cited_text → verified + source_url", () => {
    const citations = [
      { cited_text: "Founded by Jan Peeters in 2015", source_url: "https://acme.be/about" },
    ];
    const result = reconcile("Jan Peeters", citations);
    expect(result.confidence).toBe("verified");
    expect(result.source_url).toBe("https://acme.be/about");
  });

  test("quote not in any citation → inferred, no source_url", () => {
    const citations = [{ cited_text: "our leadership team", source_url: "https://acme.be/about" }];
    const result = reconcile("Sarah Chen", citations);
    expect(result.confidence).toBe("inferred");
    expect(result.source_url).toBeUndefined();
  });

  test("smart-quote drift between supporting_quote and cited_text still matches", () => {
    const citations = [
      { cited_text: 'Acme "doubled revenue" in 2026', source_url: "https://news.example/x" },
    ];
    const result = reconcile("Acme “doubled revenue” in 2026", citations);
    expect(result.confidence).toBe("verified");
  });

  test("whitespace drift survives normalization", () => {
    const citations = [
      { cited_text: "Founded\n  by\tJan  Peeters", source_url: "https://acme.be/about" },
    ];
    const result = reconcile("Founded by Jan Peeters", citations);
    expect(result.confidence).toBe("verified");
  });

  test("empty supporting_quote → inferred", () => {
    const citations = [{ cited_text: "anything", source_url: "https://x" }];
    expect(reconcile(undefined, citations).confidence).toBe("inferred");
    expect(reconcile("", citations).confidence).toBe("inferred");
  });

  test("normalizeQuote strips smart quotes and case", () => {
    expect(normalizeQuote("  Hello  World  ")).toBe("hello world");
    expect(normalizeQuote("“Quoted”")).toBe('"quoted"');
  });

  test("falls back to doc-substring when API citations are empty", () => {
    const docs = [
      {
        type: "homepage" as const,
        source_url: "https://acme.example",
        text: "Acme makes industrial widgets in Detroit since 1947.",
      },
    ];
    const result = reconcile("Acme makes industrial widgets in Detroit", [], docs);
    expect(result.confidence).toBe("verified");
    expect(result.via).toBe("doc_substring");
    expect(result.source_url).toBe("https://acme.example");
  });

  test("API citation wins over doc-substring when both match", () => {
    const docs = [
      {
        type: "homepage" as const,
        source_url: "https://acme.example",
        text: "Founded by Jan Peeters in 2015.",
      },
    ];
    const citations = [
      { cited_text: "Founded by Jan Peeters in 2015.", source_url: "https://acme.example/about" },
    ];
    const result = reconcile("Jan Peeters", citations, docs);
    expect(result.confidence).toBe("verified");
    expect(result.via).toBe("citation");
    expect(result.source_url).toBe("https://acme.example/about");
  });

  test("inferred when neither citations nor docs contain the quote", () => {
    const docs = [
      {
        type: "homepage" as const,
        source_url: "https://acme.example",
        text: "Acme makes widgets.",
      },
    ];
    const result = reconcile("Sarah Chen, CEO since 2019", [], docs);
    expect(result.confidence).toBe("inferred");
    expect(result.via).toBeUndefined();
  });
});
