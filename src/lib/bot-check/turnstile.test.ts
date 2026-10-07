// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOT_CHECK_REJECTED_MESSAGE,
  MAX_TOKEN_LENGTH,
  SITEVERIFY_URL,
  TURNSTILE_ACTION,
  isPlausibleToken,
  verifyTurnstileToken,
} from "./turnstile";

const SECRET = "real-secret-value";
const ok = (body: unknown) => vi.fn(async () => Response.json(body));
const verify = (token: string, fetchImpl: unknown, extra: { testMode?: boolean } = {}) =>
  verifyTurnstileToken(token, {
    secret: SECRET,
    allowedHostnames: ["portal.example"],
    requestId: "req-1",
    fetchImpl: fetchImpl as typeof fetch,
    ...extra,
  });
const PASS = { success: true, action: TURNSTILE_ACTION, hostname: "portal.example" };

let logged: () => string;
beforeEach(() => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  logged = () => [...out.mock.calls, ...err.mock.calls].flat().join(" ");
});
afterEach(() => vi.restoreAllMocks());

describe("isPlausibleToken", () => {
  it("accepts printable ASCII up to the maximum length only", () => {
    expect(isPlausibleToken("XXXX.DUMMY.TOKEN.XXXX")).toBe(true);
    expect(isPlausibleToken("")).toBe(false);
    expect(isPlausibleToken("x".repeat(MAX_TOKEN_LENGTH + 1))).toBe(false);
    expect(isPlausibleToken("has space")).toBe(false);
    expect(isPlausibleToken("tok\nX-Injected: 1")).toBe(false);
    expect(isPlausibleToken("tök")).toBe(false);
  });
});

describe("verifyTurnstileToken", () => {
  it("accepts a successful token for the right action and hostname", async () => {
    const fetchImpl = ok(PASS);
    await expect(verify("XXXX.DUMMY.TOKEN.XXXX", fetchImpl)).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SITEVERIFY_URL);
    const params = init.body as URLSearchParams;
    expect(params.get("secret")).toBe(SECRET);
    expect(params.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(params.has("remoteip")).toBe(false);
    expect(init.signal).toBeDefined();
  });

  it("normalises the returned hostname before comparing", async () => {
    await expect(
      verify("t", ok({ ...PASS, hostname: "Portal.Example." })),
    ).resolves.toBeUndefined();
  });

  it("rejects visitor failures with one generic 403 and logs only codes and the request id", async () => {
    const fetchImpl = ok({ success: false, "error-codes": ["invalid-input-response"] });
    await expect(verify("bad-token", fetchImpl)).rejects.toMatchObject({
      status: 403,
      code: "BOT_CHECK_FAILED",
      message: BOT_CHECK_REJECTED_MESSAGE,
    });
    expect(logged()).toContain("invalid-input-response");
    expect(logged()).toContain("req-1");
    expect(logged()).not.toContain(SECRET);
    expect(logged()).not.toContain("bad-token");
  });

  it("treats secret and request problems on our side as 503, not the visitor's fault", async () => {
    for (const code of [
      "invalid-input-secret",
      "missing-input-secret",
      "bad-request",
      "internal-error",
    ]) {
      await expect(
        verify("t", ok({ success: false, "error-codes": [code] })),
      ).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      });
    }
  });

  it("rejects tokens issued for another action or hostname", async () => {
    await expect(verify("t", ok({ ...PASS, action: "login" }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(verify("t", ok({ ...PASS, hostname: "evil.example" }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(verify("t", ok({ ...PASS, hostname: undefined }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("only checks success in test mode (Cloudflare's test secrets)", async () => {
    await expect(
      verify("t", ok({ success: true, hostname: "localhost" }), { testMode: true }),
    ).resolves.toBeUndefined();
    await expect(verify("t", ok({ success: false }), { testMode: true })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects implausible tokens without calling the service", async () => {
    const fetchImpl = ok(PASS);
    for (const token of ["", "x".repeat(MAX_TOKEN_LENGTH + 1), "with space"]) {
      await expect(verify(token, fetchImpl)).rejects.toMatchObject({ status: 403 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when verification is unavailable or answers nonsense", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(verify("t", offline)).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
    await expect(
      verify(
        "t",
        vi.fn(async () => new Response("oops", { status: 500 })),
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      verify(
        "t",
        vi.fn(async () => new Response("<html>", { status: 200 })),
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
    await expect(verify("t", ok(null))).rejects.toMatchObject({ status: 503 });
  });
});
