/**
 * The production integrations for request submission. Until an integration is
 * implemented, its slot fails closed with NOT_CONFIGURED.
 */
import { HttpError } from "@/lib/api/envelope";
import { verifyTurnstileToken } from "@/lib/bot-check/turnstile";
import { createRequestIssue } from "@/lib/github/issues";

import { assertWithinDailyCap } from "./daily-cap";
import {
  isProductionDeployment,
  isTestBotCheckSecret,
  readBotCheckHostnames,
  readBotCheckSecret,
  readDailySubmissionCap,
  readGitHubAppConfig,
} from "@/lib/config";

import type { BotCheck, SubmissionDeps } from "./submit";

const unavailable = (): never => {
  throw new HttpError(503, "NOT_CONFIGURED", "Submissions are not available yet.");
};

/** Turnstile verification for a request sent to `requestHost`. */
export function getBotCheck(requestHost: string | null, requestId?: string): BotCheck {
  return (token) => {
    const secret = readBotCheckSecret();
    return verifyTurnstileToken(token, {
      secret,
      allowedHostnames: readBotCheckHostnames(process.env, requestHost),
      testMode: !isProductionDeployment() && isTestBotCheckSecret(secret),
      requestId,
    });
  };
}

export function getSubmissionDeps(): SubmissionDeps {
  return {
    assertWithinDailyCap: () =>
      assertWithinDailyCap(readGitHubAppConfig(), readDailySubmissionCap()),
    storeScreenshot: async () => unavailable(),
    discardScreenshot: async () => {},
    createRequestIssue: (input) => createRequestIssue(readGitHubAppConfig(), input),
  };
}
