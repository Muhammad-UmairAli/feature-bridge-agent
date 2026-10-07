// @vitest-environment node
import { createVerify } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSTALLATION_TOKEN,
  TEST_APP_CONFIG,
  TEST_PRIVATE_KEY,
  TEST_PUBLIC_KEY,
  fakeGitHub,
  tokenRoute,
} from "@/test/github-fixtures";

import {
  clearInstallationTokenCache,
  createAppJwt,
  evictInstallationToken,
  getInstallationToken,
} from "./app-auth";

const TOKEN_PATH = "POST /app/installations/456/access_tokens";

let logged: () => string;
beforeEach(() => {
  clearInstallationTokenCache();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  logged = () => [...out.mock.calls, ...err.mock.calls].flat().join(" ");
});
afterEach(() => vi.restoreAllMocks());

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("createAppJwt", () => {
  it("signs a short-lived RS256 JWT for the app", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const jwt = createAppJwt(123, TEST_PRIVATE_KEY, now);
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.iss).toBe("123");
    expect(claims.iat).toBe(now / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(TEST_PUBLIC_KEY, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("getInstallationToken", () => {
  it("exchanges the app JWT for a token scoped to one repo and the requested permissions", async () => {
    const fetchImpl = fakeGitHub({ [TOKEN_PATH]: tokenRoute });
    const token = await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl });
    expect(token).toBe(INSTALLATION_TOKEN);
    const [, init] = fetchImpl.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(JSON.parse(String(init!.body))).toEqual({
      repositories: ["requests"],
      permissions: { issues: "write" },
    });
    expect(init!.signal).toBeDefined();
  });

  it("reuses a cached token until shortly before it expires", async () => {
    const fetchImpl = fakeGitHub({ [TOKEN_PATH]: tokenRoute });
    await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl });
    await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 56 minutes later the token is within the refresh margin.
    await getInstallationToken(
      TEST_APP_CONFIG,
      { issues: "write" },
      { fetchImpl, nowMs: Date.now() + 56 * 60 * 1000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches separately per permission set", async () => {
    const fetchImpl = fakeGitHub({ [TOKEN_PATH]: tokenRoute });
    await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl });
    await getInstallationToken(TEST_APP_CONFIG, { issues: "read" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps failures without leaking credentials", async () => {
    const unauthorized = fakeGitHub({
      [TOKEN_PATH]: () => new Response("bad credentials", { status: 401 }),
    });
    await expect(
      getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl: unauthorized }),
    ).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
    });
    const down = fakeGitHub({ [TOKEN_PATH]: () => new Response("", { status: 503 }) });
    await expect(
      getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl: down }),
    ).rejects.toMatchObject({
      status: 503,
    });
    const malformed = fakeGitHub({
      [TOKEN_PATH]: () => Response.json({ token: 42 }, { status: 201 }),
    });
    await expect(
      getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl: malformed }),
    ).rejects.toMatchObject({
      status: 502,
    });
    expect(logged()).not.toContain("PRIVATE KEY");
    expect(logged()).not.toMatch(/Bearer|fake-installation-token/);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const fetchImpl = fakeGitHub({ [TOKEN_PATH]: tokenRoute });
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () =>
        getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl }),
      ),
    );
    expect(new Set(tokens)).toEqual(new Set([INSTALLATION_TOKEN]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a token at 54 minutes and never trusts an expiry beyond an hour", async () => {
    const now = Date.now();
    const farFuture = () =>
      Response.json(
        { token: INSTALLATION_TOKEN, expires_at: new Date(now + 24 * 3600_000).toISOString() },
        { status: 201 },
      );
    const fetchImpl = fakeGitHub({ [TOKEN_PATH]: farFuture });
    await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl, nowMs: now });
    await getInstallationToken(
      TEST_APP_CONFIG,
      { issues: "write" },
      { fetchImpl, nowMs: now + 54 * 60_000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await getInstallationToken(
      TEST_APP_CONFIG,
      { issues: "write" },
      { fetchImpl, nowMs: now + 56 * 60_000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("mints a new token after eviction and after a failed mint", async () => {
    let fail = true;
    const fetchImpl = fakeGitHub({
      [TOKEN_PATH]: () => (fail ? new Response("", { status: 500 }) : tokenRoute({})),
    });
    await expect(
      getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl }),
    ).rejects.toBeDefined();
    fail = false;
    await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl });
    evictInstallationToken(TEST_APP_CONFIG, { issues: "write" });
    await getInstallationToken(TEST_APP_CONFIG, { issues: "write" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
