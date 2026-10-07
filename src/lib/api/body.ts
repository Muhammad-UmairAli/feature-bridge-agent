/**
 * Reads a request body with a hard byte limit. The declared Content-Length is
 * checked first, but bytes are also counted while streaming, because the
 * header can be missing (chunked uploads) or wrong. Reading stops as soon as
 * the limit is exceeded, so oversized bodies are never fully buffered.
 */
import { HttpError } from "./envelope";

const tooLarge = () =>
  new HttpError(
    413,
    "PAYLOAD_TOO_LARGE",
    "The request is too large. Screenshots must be 4 MB or smaller.",
  );

export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) throw tooLarge();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
