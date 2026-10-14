import { randomUUID } from "node:crypto";

import { readBodyWithLimit } from "@/lib/api/body";
import { HttpError, errorResponse, ok } from "@/lib/api/envelope";
import { log } from "@/lib/log";
import { BOT_CHECK_REJECTED_MESSAGE, isPlausibleToken } from "@/lib/bot-check/turnstile";
import { BOT_CHECK_HEADER } from "@/lib/bot-check/turnstile-shared";
import { getBotCheck, getSubmissionDeps } from "@/lib/requests/deps";
import { submitRequest } from "@/lib/requests/submit";
import { SCREENSHOT_MAX_BYTES } from "@/lib/requests/validation";

// Node runtime: integrations use node:crypto and the Node Blob SDK.
export const runtime = "nodejs";
// Bot check, cap, image re-encoding and upload all have their own timeouts; this bounds the total.
export const maxDuration = 30;

const ROUTE = "POST /api/v1/requests";
/** Screenshot limit plus room for the text fields and multipart framing. */
export const MAX_BODY_BYTES = SCREENSHOT_MAX_BYTES + 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  // Vercel's request id when present, so logs correlate with platform logs.
  const requestId = request.headers.get("x-vercel-id") ?? randomUUID();
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Send the request as multipart/form-data.",
      );
    }

    // Verify the visitor before spending effort on a body of up to ~4 MB.
    const token = request.headers.get(BOT_CHECK_HEADER)?.trim() ?? "";
    if (!isPlausibleToken(token)) {
      throw new HttpError(403, "BOT_CHECK_FAILED", BOT_CHECK_REJECTED_MESSAGE);
    }
    await getBotCheck(request.headers.get("host"), requestId)(token);

    const body = await readBodyWithLimit(request, MAX_BODY_BYTES);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    } catch (error) {
      log.warn("api.form_parse_failed", {
        route: ROUTE,
        requestId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new HttpError(422, "VALIDATION_FAILED", "The form data could not be read.");
    }

    const result = await submitRequest(form, getSubmissionDeps());
    log.info("request.submitted", { requestId, issue: result.id });
    const response = ok(result, 201);
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    return errorResponse(error, ROUTE, requestId);
  }
}
