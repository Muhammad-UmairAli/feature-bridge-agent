// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSubmissionDeps } from "@/lib/requests/deps";
import { VALID_DESCRIPTION, validForm } from "@/test/fixtures";

import { MAX_BODY_BYTES, POST } from "./route";

vi.mock("@/lib/requests/deps", () => ({ getSubmissionDeps: vi.fn() }));

const URL_ = "http://localhost/api/v1/requests";
const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  POST(new Request(URL_, { method: "POST", body, headers }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getSubmissionDeps).mockReturnValue({
    verifyBotCheck: async () => {},
    assertWithinDailyCap: async () => {},
    storeScreenshot: async () => "https://blob.example/x.png",
    discardScreenshot: async () => {},
    createRequestIssue: async () => 7,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/v1/requests", () => {
  it("creates a request and returns 201 with the tracking link", async () => {
    const response = await post(validForm());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 7, trackingUrl: "/requests/7" } });
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
  });

  it("never writes the description to the logs", async () => {
    const out = vi.mocked(console.log);
    const err = vi.mocked(console.error);
    await post(validForm());
    const form = new FormData();
    form.set("description", "short secret-ish text");
    await post(form);
    const logged = [...out.mock.calls, ...err.mock.calls].flat().join(" ");
    expect(logged).not.toContain(VALID_DESCRIPTION);
    expect(logged).not.toContain("secret-ish");
  });

  it("returns 413 for a streamed body over the limit without Content-Length", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 80) return controller.close();
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const response = await POST(
      new Request(URL_, {
        method: "POST",
        body: stream,
        headers: { "content-type": "multipart/form-data; boundary=x" },
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });

  it("returns 415 for non-multipart bodies", async () => {
    const response = await post(JSON.stringify({ description: "x" }), {
      "content-type": "application/json",
    });
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 413 when the declared body is too large", async () => {
    const response = await post("x", {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": String(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  it("returns 422 with field details for invalid input", async () => {
    const form = new FormData();
    form.set("description", "short");
    const response = await post(form);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toHaveProperty("description");
  });

  it("returns 422 for malformed multipart data", async () => {
    const response = await post("not really multipart", {
      "content-type": "multipart/form-data; boundary=zz",
    });
    expect(response.status).toBe(422);
  });

  it("fails closed with 503 while integrations are not configured", async () => {
    const { getSubmissionDeps: realDeps } =
      await vi.importActual<typeof import("@/lib/requests/deps")>("@/lib/requests/deps");
    vi.mocked(getSubmissionDeps).mockReturnValue(realDeps());
    const response = await post(validForm());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("NOT_CONFIGURED");
  });
});
