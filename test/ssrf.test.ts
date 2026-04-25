import { describe, expect, test } from "bun:test";
import { assertSafeUrl } from "../src/services/ssrf";

describe("assertSafeUrl", () => {
  test("rejects loopback by literal IP", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toThrow();
  });
  test("rejects 'localhost'", async () => {
    await expect(assertSafeUrl("http://localhost/")).rejects.toThrow();
  });
  test("rejects RFC 1918 private ranges", async () => {
    await expect(assertSafeUrl("http://10.0.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://172.16.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://192.168.1.1/")).rejects.toThrow();
  });
  test("rejects link-local (169.254 — AWS metadata)", async () => {
    await expect(assertSafeUrl("http://169.254.169.254/")).rejects.toThrow();
  });
  test("rejects non-http schemes", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertSafeUrl("ftp://example.com/")).rejects.toThrow();
    await expect(assertSafeUrl("javascript:alert(1)")).rejects.toThrow();
  });
  test("rejects non-standard ports", async () => {
    await expect(assertSafeUrl("http://example.com:22/")).rejects.toThrow();
    await expect(assertSafeUrl("http://example.com:8080/")).rejects.toThrow();
  });
  test("rejects malformed URLs", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toThrow();
  });
  test("rejects IPv6 loopback and link-local", async () => {
    await expect(assertSafeUrl("http://[::1]/")).rejects.toThrow();
    await expect(assertSafeUrl("http://[fe80::1]/")).rejects.toThrow();
  });
  test("rejects IPv6 unique-local (fc00::/7)", async () => {
    await expect(assertSafeUrl("http://[fd00::1]/")).rejects.toThrow();
  });
  test("rejects IPv4-mapped IPv6 pointing at private IPv4", async () => {
    await expect(assertSafeUrl("http://[::ffff:10.0.0.1]/")).rejects.toThrow();
    await expect(assertSafeUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow();
  });
});
