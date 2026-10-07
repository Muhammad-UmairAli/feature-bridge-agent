/**
 * Server-side verification of Cloudflare Turnstile tokens.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Checks success, the expected action and the hostname. The client IP is not
 * sent (the project stores and forwards no IP addresses). Problems on our side
 * (bad secret, unreachable service) fail closed with 503 and are logged as
 * errors; only verdicts about the visitor become 403.
 */
import { HttpError } from "@/lib/api/envelope";
import { normaliseHostname } from "@/lib/config";
import { log } from "@/lib/log";

import { TURNSTILE_ACTION } from "./turnstile-shared";

export { TURNSTILE_ACTION };

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const MAX_TOKEN_LENGTH = 2048;
/** One message for every visitor-side rejection, so responses don't hint at the reason. */
export const BOT_CHECK_REJECTED_MESSAGE =
  "Verification failed. Complete the check again and resubmit.";
const TIMEOUT_MS = 5000;
/** Error codes that mean our configuration or request is wrong, not the visitor. */
const SERVER_SIDE_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
  "internal-error",
]);

export interface TurnstileOptions {
  secret: string;
  /** Normalised hostnames the widget may be served from. */
  allowedHostnames: string[];
  /**
   * Local/preview use of Cloudflare's test secret: only `success` is checked,
   * because test responses don't describe a real widget.
   */
  testMode?: boolean;
  requestId?: string;
  fetchImpl?: typeof fetch;
}

const rejected = () => new HttpError(403, "BOT_CHECK_FAILED", BOT_CHECK_REJECTED_MESSAGE);
const unavailable = () =>
  new HttpError(
    503,
    "SERVICE_UNAVAILABLE",
    "Verification is temporarily unavailable. Please try again.",
  );

/** Printable ASCII only; anything else can't be a Turnstile token. */
export function isPlausibleToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7E]+$/.test(token);
}

export async function verifyTurnstileToken(
  token: string,
  options: TurnstileOptions,
): Promise<void> {
  const { secret, allowedHostnames, testMode = false, requestId, fetchImpl = fetch } = options;
  if (!isPlausibleToken(token)) throw rejected();

  let result: Record<string, unknown>;
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      log.error("botcheck.http_error", { requestId, status: response.status });
      throw unavailable();
    }
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") {
      log.error("botcheck.malformed_response", { requestId });
      throw unavailable();
    }
    result = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    log.error("botcheck.unreachable", {
      requestId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw unavailable();
  }

  const errorCodes = Array.isArray(result["error-codes"])
    ? result["error-codes"].filter((code): code is string => typeof code === "string")
    : [];
  if (result.success !== true) {
    const codes = errorCodes.join(",").slice(0, 200);
    if (errorCodes.some((code) => SERVER_SIDE_CODES.has(code))) {
      log.error("botcheck.server_side_error", { requestId, codes });
      throw unavailable();
    }
    log.info("botcheck.rejected", { requestId, codes });
    throw rejected();
  }
  if (testMode) return;

  if (result.action !== TURNSTILE_ACTION) {
    log.warn("botcheck.wrong_action", { requestId });
    throw rejected();
  }
  const hostname = typeof result.hostname === "string" ? normaliseHostname(result.hostname) : null;
  if (!hostname || !allowedHostnames.includes(hostname)) {
    log.warn("botcheck.wrong_hostname", { requestId });
    throw rejected();
  }
}
