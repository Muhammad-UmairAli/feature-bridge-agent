import { randomUUID } from "node:crypto";

import { readBodyWithLimit } from "@/lib/api/body";
import { HttpError, errorResponse, ok } from "@/lib/api/envelope";
import { log } from "@/lib/log";
import { getSubmissionDeps } from "@/lib/requests/deps";
import { submitRequest } from "@/lib/requests/submit";
import { SCREENSHOT_MAX_BYTES } from "@/lib/requests/validation";

// Node runtime: integrations use node:crypto and the Node Blob SDK.
export const runtime = "nodejs";

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
