import { describe, expect, test } from "bun:test";
import { parseEnv } from "../src/env";

const minimal = { ANTHROPIC_API_KEY: "sk-ant-fake" };

describe("parseEnv", () => {
  test("requires ANTHROPIC_API_KEY", () => {
    expect(() => parseEnv({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  test("applies sensible defaults", () => {
    const env = parseEnv(minimal);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.TIMEOUT_MS).toBe(60_000);
    expect(env.RATE_LIMIT_PER_HOUR).toBe(20);
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-5-20250929");
  });

  test("coerces numeric strings", () => {
    const env = parseEnv({ ...minimal, PORT: "8080", TIMEOUT_MS: "30000" });
    expect(env.PORT).toBe(8080);
    expect(env.TIMEOUT_MS).toBe(30_000);
  });

  test("rejects non-numeric PORT", () => {
    expect(() => parseEnv({ ...minimal, PORT: "abc" })).toThrow(/PORT/);
  });

  test("treats empty-string values as undefined", () => {
    const env = parseEnv({ ...minimal, TAVILY_API_KEY: "", DEMO_KEY: "" });
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.DEMO_KEY).toBeUndefined();
  });

  test("production requires DEMO_KEY ≥8 chars", () => {
    expect(() => parseEnv({ ...minimal, NODE_ENV: "production" })).toThrow(/DEMO_KEY/);
    expect(() => parseEnv({ ...minimal, NODE_ENV: "production", DEMO_KEY: "short" })).toThrow(
      /DEMO_KEY/,
    );
    expect(() =>
      parseEnv({ ...minimal, NODE_ENV: "production", DEMO_KEY: "long-enough-key" }),
    ).not.toThrow();
  });

  test("development accepts missing DEMO_KEY", () => {
    expect(() => parseEnv({ ...minimal, NODE_ENV: "development" })).not.toThrow();
  });

  test("rejects unknown NODE_ENV", () => {
    expect(() => parseEnv({ ...minimal, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
