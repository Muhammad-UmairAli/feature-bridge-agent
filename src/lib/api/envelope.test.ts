// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError, errorResponse, fail, ok } from "./envelope";

afterEach(() => vi.restoreAllMocks());

describe("envelopes", () => {
  it("wraps data", async () => {
    const response = ok({ id: 1 }, 201);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 1 } });
  });

  it("wraps errors with a fixed shape", async () => {
    const response = fail(422, "VALIDATION_FAILED", "Fix it", { description: "Too short" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Fix it",
        details: { description: "Too short" },
      },
    });
  });
});

describe("errorResponse", () => {
  it("maps HttpError to its status and code", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = errorResponse(
      new HttpError(429, "DAILY_LIMIT_REACHED", "Try tomorrow"),
      "test",
    );
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("DAILY_LIMIT_REACHED");
  });

  it("hides unexpected errors behind a generic 500 and logs no message text", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(new Error("secret internals: token=abc"), "test");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret internals");
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain("token=abc");
  });
});
