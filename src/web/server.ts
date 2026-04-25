import { timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { rateLimiter } from "hono-rate-limiter";
import type { ErrorResponse } from "../core/types";
import type { EnrichDeps } from "../enrich";
import type { Logger } from "../services/logger";
import { registerRoutes } from "./routes";

export interface CreateAppOptions {
  deps: EnrichDeps;
  demoKey?: string;
  timeoutMs?: number;
  rateLimitPerHour?: number;
  staticRoot?: string;
  logger?: Logger;
  /** Optional CORS allow-origin. Omit for same-origin only (the demo's default). */
  corsOrigin?: string;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = new Hono();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const rateLimitPerHour = opts.rateLimitPerHour ?? 20;

  if (opts.logger) app.use(requestLogger(opts.logger));

  if (opts.corsOrigin) {
    app.use(
      "/api/*",
      cors({
        origin: opts.corsOrigin,
        allowMethods: ["POST", "GET", "OPTIONS"],
        allowHeaders: ["Content-Type", "X-Demo-Key"],
      }),
    );
  }
  app.use("/api/*", demoKeyAuth(opts.demoKey));
  app.use(
    "/api/enrich",
    rateLimiter({
      windowMs: 3600_000,
      limit: rateLimitPerHour,
      standardHeaders: "draft-7",
      keyGenerator: extractIp,
      handler: (c) => c.json<ErrorResponse>({ error: "rate_limited" }, 429),
    }),
  );

  registerRoutes(app, opts.deps, { timeoutMs, authRequired: opts.demoKey !== undefined });

  if (opts.staticRoot) {
    app.use("/*", serveStatic({ root: opts.staticRoot }));
    app.use("/*", serveStatic({ path: `${opts.staticRoot}/index.html` }));
  }

  return app;
}

function requestLogger(log: Logger): MiddlewareHandler {
  return async (c, next) => {
    const t0 = Date.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        elapsed_ms: Date.now() - t0,
      },
      "request",
    );
  };
}

function demoKeyAuth(demoKey: string | undefined): MiddlewareHandler {
  const expected = demoKey === undefined ? null : Buffer.from(demoKey);
  return async (c, next) => {
    if (c.req.path === "/api/config") return next();
    if (expected === null) return next();
    const provided = Buffer.from(c.req.header("X-Demo-Key") ?? "");
    const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!ok) {
      return c.json<ErrorResponse>({ error: "unauthorized" }, 401);
    }
    return next();
  };
}

function extractIp(c: Context): string {
  const fly = c.req.header("Fly-Client-IP");
  if (fly) return fly;
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
}
