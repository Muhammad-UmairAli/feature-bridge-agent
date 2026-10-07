// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { HttpError } from "@/lib/api/envelope";
import { PNG_BYTES, buildForm, validForm } from "@/test/fixtures";

import { type SubmissionDeps, submitRequest } from "./submit";

function fakeDeps(overrides: Partial<SubmissionDeps> = {}) {
  const calls: string[] = [];
  const deps: SubmissionDeps = {
    verifyBotCheck: vi.fn(async () => void calls.push("bot")),
    assertWithinDailyCap: vi.fn(async () => void calls.push("cap")),
    storeScreenshot: vi.fn(async () => {
      calls.push("store");
      return "https://blob.example/screenshots/a.png";
    }),
    discardScreenshot: vi.fn(async () => void calls.push("discard")),
    createRequestIssue: vi.fn(async () => {
      calls.push("issue");
      return 42;
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("submitRequest", () => {
  it("runs the checks in order and returns the tracking link", async () => {
    const { deps, calls } = fakeDeps();
    const file = new File([PNG_BYTES], "s.png");
    const result = await submitRequest(validForm({ screenshot: file }), deps);
    expect(result).toEqual({ id: 42, trackingUrl: "/requests/42" });
    expect(calls).toEqual(["bot", "cap", "store", "issue"]);
    expect(deps.createRequestIssue).toHaveBeenCalledWith({
      description: expect.any(String),
      screenshotUrl: "https://blob.example/screenshots/a.png",
    });
  });

  it("skips storage when there is no screenshot", async () => {
    const { deps, calls } = fakeDeps();
    await submitRequest(validForm(), deps);
    expect(calls).toEqual(["bot", "cap", "issue"]);
    expect(deps.createRequestIssue).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotUrl: null }),
    );
  });

  it("rejects invalid input with 422 before calling any integration", async () => {
    const { deps, calls } = fakeDeps();
    await expect(submitRequest(buildForm({ description: "short" }), deps)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    expect(calls).toEqual([]);
  });

  it("stops at the first failing integration", async () => {
    const { deps, calls } = fakeDeps({
      assertWithinDailyCap: vi.fn(async () => {
        throw new HttpError(429, "DAILY_LIMIT_REACHED", "Try tomorrow");
      }),
    });
    await expect(
      submitRequest(validForm({ screenshot: new File([PNG_BYTES], "s.png") }), deps),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toEqual(["bot"]);
    expect(deps.storeScreenshot).not.toHaveBeenCalled();
    expect(deps.createRequestIssue).not.toHaveBeenCalled();
  });

  it("discards the stored screenshot when issue creation fails", async () => {
    const { deps, calls } = fakeDeps({
      createRequestIssue: vi.fn(async () => {
        throw new HttpError(502, "UPSTREAM_ERROR", "GitHub failed");
      }),
    });
    await expect(
      submitRequest(validForm({ screenshot: new File([PNG_BYTES], "s.png") }), deps),
    ).rejects.toMatchObject({
      status: 502,
    });
    expect(calls).toEqual(["bot", "cap", "store", "discard"]);
    expect(deps.discardScreenshot).toHaveBeenCalledWith("https://blob.example/screenshots/a.png");
  });

  it("still reports the original error if discarding fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakeDeps({
      createRequestIssue: vi.fn(async () => {
        throw new HttpError(502, "UPSTREAM_ERROR", "GitHub failed");
      }),
      discardScreenshot: vi.fn(async () => {
        throw new Error("blob down");
      }),
    });
    await expect(
      submitRequest(validForm({ screenshot: new File([PNG_BYTES], "s.png") }), deps),
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});
