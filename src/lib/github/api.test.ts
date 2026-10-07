// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GITHUB_API, githubRequest } from "./api";

let logged: () => string;
beforeEach(() => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  logged = () => err.mock.calls.flat().join(" ");
});
afterEach(() => vi.restoreAllMocks());

const call = (fetchImpl: unknown) =>
  githubRequest("/x", {
    auth: "secret-token",
    operation: "test.op",
    fetchImpl: fetchImpl as typeof fetch,
  });

describe("githubRequest", () => {
  it("sends fixed headers, refuses redirects and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: 1 }));
    await expect(call(fetchImpl)).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GITHUB_API}/x`);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
    expect((init.headers as Record<string, string>)["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("treats 5xx, 429 and rate-limited 403s as transient (503)", async () => {
    for (const response of [
      new Response("", { status: 500 }),
      new Response("", { status: 429 }),
      new Response("", { status: 403, headers: { "retry-after": "60" } }),
      new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    ]) {
      await expect(call(vi.fn(async () => response))).rejects.toMatchObject({ status: 503 });
    }
  });

  it("treats other client errors and malformed JSON as 502", async () => {
    await expect(call(vi.fn(async () => new Response("", { status: 403 })))).rejects.toMatchObject({
      status: 502,
      upstreamStatus: 403,
    });
    await expect(
      call(vi.fn(async () => new Response("<html>", { status: 200 }))),
    ).rejects.toMatchObject({
      status: 502,
    });
  });

  it("maps network failures and timeouts to 503", async () => {
    const timeout = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(call(timeout)).rejects.toMatchObject({ status: 503, upstreamStatus: 0 });
  });

  it("logs the status and GitHub's request id, never the token", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", { status: 422, headers: { "x-github-request-id": "ABCD:1234" } }),
    );
    await expect(call(fetchImpl)).rejects.toBeDefined();
    expect(logged()).toContain("ABCD:1234");
    expect(logged()).toContain("422");
    expect(logged()).not.toContain("secret-token");
  });
});
