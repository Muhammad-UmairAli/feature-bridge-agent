/**
 * Metrics job entry point (GitHub Actions, Node 24, standard library only).
 * Reads request, pull request, deployment, CI and review data with the
 * workflow's read-only token and writes the report to the job summary (and the
 * log). It changes nothing on GitHub. See compute.mts and collect.mts.
 */
import { appendFile } from "node:fs/promises";

import { collectFacts } from "./collect.mts";
import { computeMetrics, renderReport, tooManyUnreadable } from "./compute.mts";
import { readMetricsSettings } from "./settings.mts";

/**
 * The workflow token allows about 1,000 calls an hour for the whole
 * repository, shared with the agents' own jobs: use half of it at most.
 */
const CALL_BUDGET = 500;
const MAX_REQUESTS = 100;
/** Stop starting requests after this long, so a slow run still writes its report. */
const TIME_LIMIT_MS = 12 * 60_000;

async function main(): Promise<void> {
  const settings = readMetricsSettings(process.env);
  const now = new Date();
  const collected = await collectFacts({
    repo: settings.repo,
    token: settings.token,
    portalBotLogin: settings.portalBotLogin,
    agentAppLogin: settings.agentAppLogin,
    days: settings.days,
    maxRequests: MAX_REQUESTS,
    callBudget: CALL_BUDGET,
    now,
    deadline: now.getTime() + TIME_LIMIT_MS,
    log: (line) => console.error(line),
  });
  const report = renderReport(computeMetrics(collected.requests, settings.agentAppLogin), {
    days: settings.days,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    unreadable: collected.unreadable,
    tooBusy: collected.tooBusy,
    stoppedEarly: collected.stoppedEarly,
    truncated: collected.truncated,
    requestLimit: MAX_REQUESTS,
  });
  console.log(report);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, report);

  // A green run must not hide a systematic failure: the report is written
  // first, then the job fails if a fifth or more of the requests were unreadable.
  if (tooManyUnreadable(collected.requests.length, collected.unreadable)) {
    console.error(
      `::error::${collected.unreadable} request(s) could not be read (see the log); the numbers are unreliable.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // The message names the failing operation and status, never a response body or a value.
  console.error(
    `::error::Metrics could not be computed. ${error instanceof Error ? error.message : "Unknown error."}`,
  );
  process.exitCode = 1;
});
