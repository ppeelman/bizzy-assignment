import { parseEnv } from "./env";
import { AnthropicLLMService } from "./services/llm";
import { createLogger } from "./services/logger";
import { NewsClient } from "./services/news";
import { Scraper } from "./services/scrapers";
import { SourcesService } from "./services/sources";
import { createApp } from "./web/server";

const env = parseEnv();

const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
});

const scraper = new Scraper({
  cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
  logger: logger.child({ service: "scraper" }),
});
const news = new NewsClient({
  tavilyApiKey: env.TAVILY_API_KEY,
  logger: logger.child({ service: "news" }),
});
const sourceProvider = new SourcesService(scraper, news, logger.child({ service: "sources" }));
const llmClient = new AnthropicLLMService({
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL,
  logger: logger.child({ service: "llm" }),
});

const app = createApp({
  deps: { sourceProvider, llmClient, logger: logger.child({ service: "enrich" }) },
  demoKey: env.DEMO_KEY,
  timeoutMs: env.TIMEOUT_MS,
  rateLimitPerHour: env.RATE_LIMIT_PER_HOUR,
  staticRoot: "./dist",
  logger: logger.child({ service: "http" }),
  corsOrigin: env.CORS_ORIGIN,
});

Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 90 });
logger.info({ port: env.PORT, model: env.ANTHROPIC_MODEL, env: env.NODE_ENV }, "server started");
