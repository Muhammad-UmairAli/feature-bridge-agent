/**
 * Response envelopes for every API route:
 *   success: { "data": ... }
 *   failure: { "error": { "code", "message", "details" } }
 */
import { log } from "@/lib/log";

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "BOT_CHECK_FAILED"
  | "DAILY_LIMIT_REACHED"
  | "NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "NOT_CONFIGURED"
  | "INTERNAL_ERROR";

/** HTTP statuses the API uses (guardrail: don't improvise). */
export type ErrorStatus = 403 | 404 | 413 | 415 | 422 | 429 | 500 | 502 | 503;

/** Field name → human-readable problem, for 422 responses. */
export type ErrorDetails = Record<string, string> | null;

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details: ErrorDetails };
}

/** An expected failure that maps directly to an HTTP response. */
export class HttpError extends Error {
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(status: ErrorStatus, code: ErrorCode, message: string, details: ErrorDetails = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ data }, { status });
}

export function fail(
  status: ErrorStatus,
  code: ErrorCode,
  message: string,
  details: ErrorDetails = null,
): Response {
  const body: ApiErrorBody = { error: { code, message, details } };
  return Response.json(body, { status });
}

/**
 * The single error handler for routes: known HttpErrors become their response;
 * anything else is logged and returned as a generic 500 without internals.
 */
export function errorResponse(error: unknown, route: string, requestId?: string): Response {
  let response: Response;
  if (error instanceof HttpError) {
    const level = error.status >= 500 ? "error" : "info";
    log[level]("api.request_failed", { route, requestId, status: error.status, code: error.code });
    response = fail(error.status, error.code, error.message, error.details);
  } else {
    log.error("api.unhandled_error", {
      route,
      requestId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    response = fail(500, "INTERNAL_ERROR", "Something went wrong. Please try again later.");
  }
  if (requestId) response.headers.set("x-request-id", requestId);
  return response;
}
