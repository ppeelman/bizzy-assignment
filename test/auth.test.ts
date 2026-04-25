import { describe, expect, test } from "bun:test";
import type { EnrichDeps, LLMClient, SourceProvider } from "../src/enrich";
import { createApp } from "../src/web/server";

const stubProvider: SourceProvider = {
  async fetchSources() {
    return { ok: false, code: "source_fetch_failed", reason: "stub", failures: [] };
  },
};
const stubLLM: LLMClient = {
  async synthesize() {
    throw new Error("not_called");
  },
};
const stubDeps: EnrichDeps = { sourceProvider: stubProvider, llmClient: stubLLM };

const enrichBody = JSON.stringify({ url: "https://example.com" });

function build(demoKey?: string) {
  return createApp({ deps: stubDeps, demoKey });
}

describe("demo-key middleware", () => {
  test("DEMO_KEY undefined → open access (local dev mode)", async () => {
    const app = build(undefined);
    const res = await app.request("/api/enrich", {
      method: "POST",
      body: enrichBody,
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).not.toBe(401);
  });

  test("DEMO_KEY set, correct header → not 401", async () => {
    const app = build("test-key-1234");
    const res = await app.request("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Key": "test-key-1234" },
      body: enrichBody,
    });
    expect(res.status).not.toBe(401);
  });

  test("DEMO_KEY set, wrong header → 401", async () => {
    const app = build("test-key-1234");
    const res = await app.request("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Key": "wrong" },
      body: enrichBody,
    });
    expect(res.status).toBe(401);
  });

  test("DEMO_KEY set, missing header → 401", async () => {
    const app = build("test-key-1234");
    const res = await app.request("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: enrichBody,
    });
    expect(res.status).toBe(401);
  });

  test("DEMO_KEY set to empty string still requires matching empty header", async () => {
    const app = build("");
    const res = await app.request("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Key": "" },
      body: enrichBody,
    });
    expect(res.status).not.toBe(401);
  });
});
