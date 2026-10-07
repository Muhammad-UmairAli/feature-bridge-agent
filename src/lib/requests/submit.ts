/**
 * Submission flow for a feature request. Each integration is injected, so the
 * order of checks and the failure behaviour can be tested without network calls.
 *
 * The bot check runs earlier, in the route, before the body is read.
 * Order here: validate → daily cap → store screenshot → create issue. Nothing
 * is stored or created unless every earlier step passed.
 */
import { HttpError } from "@/lib/api/envelope";
import { log } from "@/lib/log";

import { type ValidatedScreenshot, validateSubmission } from "./validation";

/** Throws HttpError(403) when the token is rejected, (503) when unverifiable. */
export type BotCheck = (token: string) => Promise<void>;

export interface SubmissionDeps {
  /** Throws HttpError(429) at the cap, (503) when the count can't be read. */
  assertWithinDailyCap(): Promise<void>;
  /** Stores the screenshot and returns its public URL. */
  storeScreenshot(screenshot: ValidatedScreenshot): Promise<string>;
  /** Best-effort removal of a stored screenshot whose request failed later. */
  discardScreenshot(url: string): Promise<void>;
  /** Creates the request issue and returns its number. */
  createRequestIssue(input: { description: string; screenshotUrl: string | null }): Promise<number>;
}

export interface SubmissionResult {
  id: number;
  trackingUrl: string;
}

export async function submitRequest(
  form: FormData,
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  const result = await validateSubmission(form);
  if (!result.ok) {
    throw new HttpError(
      422,
      "VALIDATION_FAILED",
      "Please fix the highlighted fields.",
      result.details,
    );
  }
  const { description, screenshot } = result.value;

  await deps.assertWithinDailyCap();
  const screenshotUrl = screenshot ? await deps.storeScreenshot(screenshot) : null;
  let id: number;
  try {
    id = await deps.createRequestIssue({ description, screenshotUrl });
  } catch (error) {
    // Don't leave an orphaned public file behind when the request itself failed.
    if (screenshotUrl) {
      await deps.discardScreenshot(screenshotUrl).catch(() => {
        log.warn("request.screenshot_discard_failed");
      });
    }
    throw error;
  }

  return { id, trackingUrl: `/requests/${id}` };
}
