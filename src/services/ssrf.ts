import dns from "node:dns";
import ipaddr from "ipaddr.js";

export class SsrfError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "SsrfError";
  }
}

// ipaddr.range() returns "private", "loopback", "linkLocal", "uniqueLocal",
// "multicast", "broadcast", "carrierGradeNat", "reserved", "unspecified",
// or "unicast" (the only one we want to allow for outbound fetches).
const SAFE_RANGES: ReadonlySet<string> = new Set(["unicast"]);

function isSafeIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let parsed = ipaddr.parse(ip);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return SAFE_RANGES.has(parsed.range());
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid_url");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new SsrfError("unsupported_scheme");
  if (u.port && !["", "80", "443"].includes(u.port)) throw new SsrfError("unsupported_port");

  const hostname = u.hostname;
  if (!hostname) throw new SsrfError("invalid_host");
  if (hostname === "localhost") throw new SsrfError("private_address");

  // IP literals (incl. bracketed IPv6) — check directly without DNS.
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (ipaddr.isValid(literal)) {
    if (!isSafeIp(literal)) throw new SsrfError("private_address");
    return u;
  }

  let address: string;
  try {
    const lookup = await dns.promises.lookup(hostname);
    address = lookup.address;
  } catch {
    throw new SsrfError("dns_failed");
  }
  if (!isSafeIp(address)) throw new SsrfError("private_address");

  return u;
}
