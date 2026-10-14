// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { checkBeforeSubmit, postRequest } from "./client";
import { SCREENSHOT_MAX_BYTES } from "./validation";

const json = (status: number, body: unknown) => async () => Response.json(body, { status });

describe("checkBeforeSubmit", () => {
  it("passes a valid description without a screenshot", () => {
    expect(checkBeforeSubmit("A perfectly reasonable feature request", null)).toEqual({});
  });

  it("flags short descriptions (after stripping hidden characters)", () => {
    expect(checkBeforeSubmit("a" + "​".repeat(40), null).description).toMatch(/at least 20/);
  });

  it("flags descriptions over the maximum", () => {
    expect(checkBeforeSubmit("a".repeat(5001), null).description).toMatch(/under 5000/);
  });

  it("requires the publish acknowledgement when a screenshot is attached", () => {
    const png = new File(["x"], "x.png", { type: "image/png" });
    expect(checkBeforeSubmit("A perfectly reasonable feature request", png).screenshot).toMatch(
      /can be published/,
    );
    expect(checkBeforeSubmit("A perfectly reasonable feature request", png, true)).toEqual({});
  });

  it("flags unsupported or oversized screenshots", () => {
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    expect(checkBeforeSubmit("A perfectly reasonable feature request", svg).screenshot).toMatch(
      /PNG, JPEG or WebP/,
    );
    const big = new File([new Uint8Array(SCREENSHOT_MAX_BYTES + 1)], "x.png", {
      type: "image/png",
    });
    expect(checkBeforeSubmit("A perfectly reasonable feature request", big).screenshot).toMatch(
      /4 MB/,
    );
  });
});

describe("postRequest", () => {
  it("returns the created request", async () => {
    const fetchImpl = vi.fn(json(201, { data: { id: 9, trackingUrl: "/requests/9" } }));
    const outcome = await postRequest(new FormData(), "tok", fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "created", id: 9, trackingUrl: "/requests/9" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/requests",
      expect.objectContaining({ method: "POST", headers: { "x-bot-check-token": "tok" } }),
    );
  });

  it("returns field errors for 422", async () => {
    const outcome = await postRequest(
      new FormData(),
      "tok",
      json(422, {
        error: {
          code: "VALIDATION_FAILED",
          message: "Fix it",
          details: { description: "Too short" },
        },
      }) as unknown as typeof fetch,
    );
    expect(outcome).toEqual({
      kind: "invalid",
      message: "Fix it",
      fields: { description: "Too short" },
    });
  });

  it("passes server messages through for other errors", async () => {
    const outcome = await postRequest(
      new FormData(),
      "tok",
      json(429, {
        error: { code: "DAILY_LIMIT_REACHED", message: "Try tomorrow", details: null },
      }) as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ kind: "failed", message: "Try tomorrow" });
  });

  it("handles network failures and non-JSON responses without throwing", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(
      (await postRequest(new FormData(), "tok", offline as unknown as typeof fetch)).kind,
    ).toBe("failed");
    const html = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const outcome = await postRequest(new FormData(), "tok", html as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "failed", message: expect.stringMatching(/couldn't submit/) });
  });

  it("drops malformed error details instead of trusting them", async () => {
    const outcome = await postRequest(
      new FormData(),
      "tok",
      json(422, {
        error: {
          code: "X",
          message: "Fix it",
          details: { description: { nested: true }, other: "x", screenshot: "Bad" },
        },
      }) as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ kind: "invalid", message: "Fix it", fields: { screenshot: "Bad" } });
  });

  it("treats a malformed 201 or an off-site tracking link as a failure", async () => {
    for (const data of [
      { id: "7", trackingUrl: "/requests/7" },
      { id: 7 },
      { id: 7, trackingUrl: "//evil.example/x" },
    ]) {
      const outcome = await postRequest(
        new FormData(),
        "tok",
        json(201, { data }) as unknown as typeof fetch,
      );
      expect(outcome.kind).toBe("failed");
    }
  });

  it("falls back to a generic message when the server sends an empty one", async () => {
    const outcome = await postRequest(
      new FormData(),
      "tok",
      json(503, { error: { code: "X", message: "", details: null } }) as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ kind: "failed", message: expect.stringMatching(/couldn't submit/) });
  });
});
