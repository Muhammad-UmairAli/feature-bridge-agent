/**
 * The production integrations for request submission. Each one reads its
 * configuration per call and fails closed (503 NOT_CONFIGURED) when it's missing.
 */
import { verifyTurnstileToken } from "@/lib/bot-check/turnstile";
import { createRequestIssue } from "@/lib/github/issues";
import { discardScreenshot, storeScreenshot } from "@/lib/storage/screenshots";
import {
  isProductionDeployment,
  isTestBotCheckSecret,
  readBlobToken,
  readBotCheckHostnames,
  readBotCheckSecret,
  readDailySubmissionCap,
  readGitHubAppConfig,
} from "@/lib/config";

import { assertWithinDailyCap } from "./daily-cap";
import type { BotCheck, SubmissionDeps } from "./submit";

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
    // async, so a missing token rejects (503) instead of throwing synchronously
    storeScreenshot: async (screenshot) => storeScreenshot(screenshot, readBlobToken()),
    discardScreenshot: async (url) => discardScreenshot(url, readBlobToken()),
    createRequestIssue: (input) => createRequestIssue(readGitHubAppConfig(), input),
  };
}
