// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/lib/api/envelope";
import { getBotCheck, getSubmissionDeps } from "@/lib/requests/deps";
import { VALID_DESCRIPTION, validForm } from "@/test/fixtures";

import { MAX_BODY_BYTES, POST } from "./route";

vi.mock("@/lib/requests/deps", () => ({ getSubmissionDeps: vi.fn(), getBotCheck: vi.fn() }));

const URL_ = "http://portal.example/api/v1/requests";
const TOKEN = { "x-bot-check-token": "XXXX.DUMMY.TOKEN.XXXX", host: "portal.example" };
const post = (body: BodyInit, headers: Record<string, string> = TOKEN) =>
  POST(new Request(URL_, { method: "POST", body, headers }));
const botCheck = vi.fn(async (token: string) => void token);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  botCheck.mockReset();
  botCheck.mockImplementation(async () => {});
  vi.mocked(getBotCheck).mockReturnValue(botCheck);
  vi.mocked(getSubmissionDeps).mockReturnValue({
    assertWithinDailyCap: async () => {},
    storeScreenshot: async () => "https://blob.example/x.png",
    discardScreenshot: async () => {},
    createRequestIssue: async () => 7,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/v1/requests", () => {
  it("verifies the token for this host, then creates the request (201)", async () => {
    const response = await post(validForm());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 7, trackingUrl: "/requests/7" } });
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(getBotCheck).toHaveBeenCalledWith(
      "portal.example",
      response.headers.get("x-request-id"),
    );
    expect(botCheck).toHaveBeenCalledWith("XXXX.DUMMY.TOKEN.XXXX");
  });

  it("rejects a missing token with 403 without reading the body", async () => {
    const request = new Request(URL_, {
      method: "POST",
      body: validForm(),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("BOT_CHECK_FAILED");
    expect(request.bodyUsed).toBe(false);
    expect(botCheck).not.toHaveBeenCalled();
  });

  it("returns the bot check's verdict (403) before validating the body", async () => {
    botCheck.mockRejectedValue(new HttpError(403, "BOT_CHECK_FAILED", "Verification failed."));
    const form = new FormData();
    form.set("description", "short");
    const response = await post(form);
    expect(response.status).toBe(403);
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
        headers: { "content-type": "multipart/form-data; boundary=x", ...TOKEN },
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });

  it("returns 415 for non-multipart bodies", async () => {
    const response = await post(JSON.stringify({ description: "x" }), {
      "content-type": "application/json",
      ...TOKEN,
    });
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 413 when the declared body is too large", async () => {
    const response = await post("x", {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": String(MAX_BODY_BYTES + 1),
      ...TOKEN,
    });
    expect(response.status).toBe(413);
  });

  it("returns 422 with field details for invalid input", async () => {
    const form = new FormData();
    form.set("description", "short");
    const response = await post(form);
    expect(response.status).toBe(422);
    expect((await response.json()).error.details).toHaveProperty("description");
  });

  it("returns 422 for malformed multipart data", async () => {
    const response = await post("not really multipart", {
      "content-type": "multipart/form-data; boundary=zz",
      ...TOKEN,
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("fails closed with 503 while the remaining integrations are not configured", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/requests/deps")>("@/lib/requests/deps");
    vi.mocked(getSubmissionDeps).mockReturnValue(actual.getSubmissionDeps());
    const response = await post(validForm());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("NOT_CONFIGURED");
  });

  it("passes a 503 from the bot check through and stops", async () => {
    botCheck.mockRejectedValue(
      new HttpError(503, "SERVICE_UNAVAILABLE", "Verification is temporarily unavailable."),
    );
    const response = await post(validForm());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("rejects an implausible token with the generic 403 before the bot check", async () => {
    const response = await post(validForm(), {
      "x-bot-check-token": "has spaces in it",
      host: "portal.example",
    });
    expect(response.status).toBe(403);
    expect(botCheck).not.toHaveBeenCalled();
  });
});
