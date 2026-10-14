// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readBodyWithLimit } from "./body";

/** A streamed body with no Content-Length, delivered in chunks. */
function chunkedRequest(chunks: number, chunkSize: number): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return new Request("http://localhost/", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("readBodyWithLimit", () => {
  it("returns the full body when within the limit", async () => {
    const body = await readBodyWithLimit(
      new Request("http://localhost/", { method: "POST", body: "hello" }),
      10,
    );
    expect(new TextDecoder().decode(body)).toBe("hello");
  });

  it("stops a chunked body without Content-Length once it exceeds the limit", async () => {
    const request = chunkedRequest(100, 1024); // 100 KB streamed
    await expect(readBodyWithLimit(request, 10 * 1024)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a declared length over the limit before reading", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      body: "x",
      headers: { "content-length": "999999" },
    });
    await expect(readBodyWithLimit(request, 10)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("returns an empty body when there is none", async () => {
    expect(
      (await readBodyWithLimit(new Request("http://localhost/", { method: "POST" }), 10))
        .byteLength,
    ).toBe(0);
  });
});

describe("readBodyWithLimit with a malformed Content-Length", () => {
  it("rejects a non-numeric declared length", async () => {
    const fake = {
      headers: new Headers({ "content-length": "abc" }),
      body: null,
    } as unknown as Request;
    await expect(readBodyWithLimit(fake, 10)).rejects.toMatchObject({ status: 413 });
  });
});
