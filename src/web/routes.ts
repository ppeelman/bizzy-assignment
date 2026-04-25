import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { EnrichmentResponse, ErrorResponse, SourceFailure } from "../core/types";
import { type EnrichDeps, type EnrichErrorCode, enrichCompany } from "../enrich";

const EnrichRequestSchema = z.object({ url: z.string().url() });

export interface RouteOpts {
  timeoutMs: number;
  authRequired: boolean;
}

export function registerRoutes(app: Hono, deps: EnrichDeps, opts: RouteOpts): void {
  app.get("/health", (c) => c.text("ok"));

  app.get("/api/config", (c) => c.json({ authRequired: opts.authRequired }));

  app.post("/api/enrich", zValidator("json", EnrichRequestSchema), async (c) => {
    const { url } = c.req.valid("json");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), opts.timeoutMs);

    try {
      const result = await enrichCompany(deps, url, ac.signal);

      if (result.ok) {
        const body: EnrichmentResponse = { ...result.entity, _debug: result.metadata };
        return c.json(body);
      }

      const [body, status] = errorPayload(result.error);
      return c.json(body, status);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);

      const code: EnrichErrorCode =
        reason.includes("timeout") || ac.signal.aborted ? "timeout" : "internal_error";

      const [body, status] = errorPayload({ code, reason });

      return c.json(body, status);
    } finally {
      clearTimeout(timer);
    }
  });
}

function errorPayload(error: {
  code: EnrichErrorCode;
  reason?: string;
  failures?: SourceFailure[];
}): [ErrorResponse, ContentfulStatusCode] {
  const status: ContentfulStatusCode =
    error.code === "ssrf_rejected" || error.code === "source_fetch_failed"
      ? 400
      : error.code === "claude_failed" || error.code === "claude_parse_failed"
        ? 502
        : error.code === "timeout"
          ? 504
          : 500;
  return [{ error: error.code, reason: error.reason, failures: error.failures }, status];
}
