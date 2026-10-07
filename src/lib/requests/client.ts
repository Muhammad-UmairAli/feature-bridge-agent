/**
 * Browser-side helpers for the request form: the same checks the server runs
 * (for fast feedback; the server stays authoritative) and a typed wrapper
 * around POST /api/v1/requests.
 */
import { BOT_CHECK_HEADER } from "@/lib/bot-check/turnstile-shared";

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  SCREENSHOT_CONSENT_REQUIRED,
  SCREENSHOT_MAX_BYTES,
  characterCount,
  normaliseDescription,
} from "./validation";

export const ACCEPTED_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type FieldErrors = Partial<Record<"description" | "screenshot" | "botCheckToken", string>>;

export function checkBeforeSubmit(
  description: string,
  screenshot: File | null,
  screenshotConsent = false,
): FieldErrors {
  const errors: FieldErrors = {};
  const length = characterCount(normaliseDescription(description));
  if (length < DESCRIPTION_MIN_LENGTH) {
    errors.description = `Describe the feature in at least ${DESCRIPTION_MIN_LENGTH} characters.`;
  } else if (length > DESCRIPTION_MAX_LENGTH) {
    errors.description = `Keep the description under ${DESCRIPTION_MAX_LENGTH} characters.`;
  }
  if (screenshot) {
    if (!(ACCEPTED_SCREENSHOT_TYPES as readonly string[]).includes(screenshot.type)) {
      errors.screenshot = "Screenshots must be PNG, JPEG or WebP images.";
    } else if (screenshot.size > SCREENSHOT_MAX_BYTES) {
      errors.screenshot = "Screenshots must be 4 MB or smaller.";
    } else if (!screenshotConsent) {
      errors.screenshot = SCREENSHOT_CONSENT_REQUIRED;
    }
  }
  return errors;
}

export type SubmitOutcome =
  | { kind: "created"; id: number; trackingUrl: string }
  | { kind: "invalid"; message: string; fields: FieldErrors }
  | { kind: "failed"; message: string };

const GENERIC_FAILURE = "We couldn't submit your request. Please try again in a moment.";
const FIELD_NAMES = ["description", "screenshot", "botCheckToken"] as const;

/** POST the form and translate the response envelope into an outcome. Never throws. */
export async function postRequest(
  form: FormData,
  botCheckToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/v1/requests", {
      method: "POST",
      body: form,
      headers: { [BOT_CHECK_HEADER]: botCheckToken },
    });
  } catch {
    return { kind: "failed", message: "Network error. Check your connection and try again." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", message: GENERIC_FAILURE };
  }

  const created = response.status === 201 ? readCreated(body) : null;
  if (created) return { kind: "created", ...created };

  const error = readError(body);
  if (response.status === 422 && error) return { kind: "invalid", ...error };
  return { kind: "failed", message: error?.message || GENERIC_FAILURE };
}

/** Accept only a safe integer id and a same-site path, so the link can't point elsewhere. */
function readCreated(body: unknown): { id: number; trackingUrl: string } | null {
  const data = (body as { data?: { id?: unknown; trackingUrl?: unknown } } | null)?.data;
  const { id, trackingUrl } = data ?? {};
  if (!Number.isSafeInteger(id) || (id as number) <= 0) return null;
  if (
    typeof trackingUrl !== "string" ||
    !trackingUrl.startsWith("/") ||
    trackingUrl.startsWith("//")
  )
    return null;
  return { id: id as number, trackingUrl };
}

/** Read the error envelope defensively: unknown or non-string fields are dropped. */
function readError(body: unknown): { message: string; fields: FieldErrors } | null {
  const error = (body as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  if (!error || typeof error.message !== "string") return null;
  const fields: FieldErrors = {};
  const details = error.details;
  if (details && typeof details === "object") {
    for (const name of FIELD_NAMES) {
      const value = (details as Record<string, unknown>)[name];
      if (typeof value === "string" && value) fields[name] = value;
    }
  }
  return { message: error.message || GENERIC_FAILURE, fields };
}
