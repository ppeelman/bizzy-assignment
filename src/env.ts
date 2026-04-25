import { z } from "zod";

const Schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),

    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-5-20250929"),

    TAVILY_API_KEY: z.string().min(1).optional(),
    CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
    CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),

    DEMO_KEY: z.string().optional(),
    /** Optional CORS allow-origin. Unset → no CORS middleware (same-origin SPA only). */
    CORS_ORIGIN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && (!env.DEMO_KEY || env.DEMO_KEY.length < 8)) {
      ctx.addIssue({
        code: "custom",
        path: ["DEMO_KEY"],
        message: "must be set (≥8 chars) in production",
      });
    }
  });

export type Env = z.infer<typeof Schema>;

export function parseEnv(source: Record<string, string | undefined> = Bun.env): Env {
  // .env files commonly hold empty-string placeholders ("FOO=") for unset values;
  // treat those as undefined so optional fields don't trip min-length validators.
  const normalized: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    normalized[k] = v === "" ? undefined : v;
  }

  const result = Schema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
