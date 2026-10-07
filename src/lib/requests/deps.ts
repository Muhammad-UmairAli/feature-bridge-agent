/**
 * The production integrations for request submission. Until an integration is
 * implemented, its slot fails closed with NOT_CONFIGURED.
 */
import { HttpError } from "@/lib/api/envelope";

import type { SubmissionDeps } from "./submit";

const unavailable = (): never => {
  throw new HttpError(503, "NOT_CONFIGURED", "Submissions are not available yet.");
};

export function getSubmissionDeps(): SubmissionDeps {
  return {
    verifyBotCheck: async () => unavailable(),
    assertWithinDailyCap: async () => unavailable(),
    storeScreenshot: async () => unavailable(),
    discardScreenshot: async () => {},
    createRequestIssue: async () => unavailable(),
  };
}
