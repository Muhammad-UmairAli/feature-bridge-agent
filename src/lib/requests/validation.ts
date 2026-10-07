/**
 * Validation for submitted requests. Screenshots are identified by their file
 * signature, never by the client-declared type or file name.
 */
import type { ErrorDetails } from "@/lib/api/envelope";

export const DESCRIPTION_MIN_LENGTH = 20;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const SCREENSHOT_CONSENT_REQUIRED =
  "Confirm that the screenshot can be published, or remove it.";

export type ScreenshotType = "image/png" | "image/jpeg" | "image/webp";

export interface ValidatedScreenshot {
  bytes: Uint8Array;
  contentType: ScreenshotType;
  extension: "png" | "jpg" | "webp";
}

export interface ValidatedRequest {
  description: string;
  screenshot: ValidatedScreenshot | null;
}

export type ValidationResult =
  { ok: true; value: ValidatedRequest } | { ok: false; details: NonNullable<ErrorDetails> };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

/** Detect PNG, JPEG or WebP from the first bytes; null for anything else. */
export function detectScreenshotType(bytes: Uint8Array): Omit<ValidatedScreenshot, "bytes"> | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: "image/png", extension: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

/**
 * Characters removed before counting and storing: C0/C1 controls (except tab
 * and newline), zero-width characters, bidi embedding/override/isolate
 * controls, and Unicode tag characters. They are invisible to a human reviewer
 * but would still reach anything that reads the text, such as an LLM.
 */
const HIDDEN_CHARACTERS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** NFC-normalise, unify line endings, strip hidden characters and trim. */
export function normaliseDescription(raw: string): string {
  return raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(HIDDEN_CHARACTERS, "").trim();
}

/** Length in Unicode code points (an emoji counts once), the rule the form also uses. */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

export async function validateSubmission(form: FormData): Promise<ValidationResult> {
  const details: Record<string, string> = {};

  // Each field may appear at most once; duplicates are rejected, not guessed at.
  for (const field of ["description", "screenshot"]) {
    if (form.getAll(field).length > 1) details[field] = "Send this field only once.";
  }

  const rawDescription = form.get("description");
  const description =
    typeof rawDescription === "string" ? normaliseDescription(rawDescription) : "";
  const length = characterCount(description);
  if (!details.description) {
    if (length < DESCRIPTION_MIN_LENGTH) {
      details.description = `Describe the feature in at least ${DESCRIPTION_MIN_LENGTH} characters.`;
    } else if (length > DESCRIPTION_MAX_LENGTH) {
      details.description = `Keep the description under ${DESCRIPTION_MAX_LENGTH} characters.`;
    }
  }

  let screenshot: ValidatedScreenshot | null = null;
  const rawFile = form.get("screenshot");
  if (!details.screenshot && rawFile !== null) {
    if (typeof rawFile === "string") {
      if (rawFile !== "") details.screenshot = "Attach the screenshot as a file.";
    } else if (rawFile.size > SCREENSHOT_MAX_BYTES) {
      details.screenshot = "Screenshots must be 4 MB or smaller.";
    } else if (rawFile.size > 0) {
      const bytes = new Uint8Array(await rawFile.arrayBuffer());
      const type = detectScreenshotType(bytes);
      if (!type) {
        details.screenshot = "Screenshots must be PNG, JPEG or WebP images.";
      } else if (form.get("screenshotConsent") !== "yes") {
        details.screenshot = SCREENSHOT_CONSENT_REQUIRED;
      } else {
        screenshot = { bytes, ...type };
      }
    }
  }

  if (Object.keys(details).length > 0) return { ok: false, details };
  return { ok: true, value: { description, screenshot } };
}
