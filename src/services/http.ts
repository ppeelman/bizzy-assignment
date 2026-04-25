export interface FetchOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const UA =
  "Mozilla/5.0 (compatible; BizzyEnrichmentBot/0.1; +https://github.com/anthropics/claude-code)";

export async function fetchWithTimeout(
  url: string,
  opts: FetchOpts & RequestInit = {},
): Promise<Response> {
  const { timeoutMs = 5000, signal: outerSignal, ...rest } = opts;
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  return fetch(url, {
    ...rest,
    headers: { "User-Agent": UA, ...(rest.headers ?? {}) },
    signal,
    redirect: rest.redirect ?? "follow",
  });
}
