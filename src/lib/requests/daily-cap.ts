/**
 * Daily total cap on accepted submissions. Counts today's (UTC) request issues
 * created by a bot (the App) through the issues list API, because the search
 * API's index lags. Paging stops as soon as the cap is reached.
 *
 * Every uncertain outcome fails closed: running out of pages, a malformed
 * reply or an unreadable date blocks submissions instead of letting them in.
 *
 * Known limits, acceptable for an abuse cap:
 * - Count-then-create isn't atomic; concurrent submissions near the cap can
 *   slightly exceed it, and the window resets at midnight UTC.
 * - Deleting, transferring or unlabelling today's issues lowers the count.
 * - Any bot-authored issue with the label counts. That can only over-count
 *   (blocking early), never let extra submissions through.
 */
import { HttpError } from "@/lib/api/envelope";
import type { GitHubAppConfig } from "@/lib/config";
import { log } from "@/lib/log";
import { GitHubError, githubRequest } from "@/lib/github/api";
import {
  type InstallationPermissions,
  evictInstallationToken,
  getInstallationToken,
} from "@/lib/github/app-auth";

import { LABELS } from "./labels";

const PAGE_SIZE = 100;
/** Enough pages for the largest allowed cap plus unrelated labelled items. */
export const MAX_PAGES = 20;
const READ_PERMISSIONS: InstallationPermissions = { issues: "read" };

interface IssueSummary {
  created_at?: unknown;
  pull_request?: unknown;
  user?: { type?: unknown } | null;
}

export function startOfUtcDay(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const malformed = () => {
  log.error("daily_cap.malformed_response");
  return new HttpError(
    502,
    "UPSTREAM_ERROR",
    "We couldn't reach GitHub correctly. Please try again later.",
  );
};

async function countWithToken(
  config: GitHubAppConfig,
  stopAt: number,
  dayStart: Date,
  fetchImpl: typeof fetch | undefined,
): Promise<number> {
  const token = await getInstallationToken(config, READ_PERMISSIONS, { fetchImpl });
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      labels: LABELS.portalRequest,
      state: "all",
      sort: "created",
      direction: "desc",
      // Issues created today were also updated today, so this only trims older ones.
      since: dayStart.toISOString(),
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const issues = await githubRequest<unknown>(
      `/repos/${config.owner}/${config.repo}/issues?${query}`,
      {
        auth: token,
        operation: "issues.count_today",
        fetchImpl,
      },
    );
    if (!Array.isArray(issues)) throw malformed();

    for (const issue of issues as IssueSummary[]) {
      const created = typeof issue?.created_at === "string" ? Date.parse(issue.created_at) : NaN;
      if (Number.isNaN(created)) throw malformed();
      // Sorted newest first: anything before today ends the count.
      if (created < dayStart.getTime()) return count;
      const isPullRequest = issue.pull_request !== undefined && issue.pull_request !== null;
      if (!isPullRequest && issue.user?.type === "Bot") {
        count += 1;
        if (count >= stopAt) return count;
      }
    }
    if (issues.length < PAGE_SIZE) return count;
  }
  // Pages ran out before reaching yesterday or the cap: the count is unknown.
  log.error("daily_cap.page_limit_reached", { pages: MAX_PAGES });
  throw new HttpError(
    503,
    "SERVICE_UNAVAILABLE",
    "Submissions are temporarily unavailable. Please try again later.",
  );
}

/**
 * How many request issues the App created since the start of today (UTC),
 * counting no further than `stopAt`. Retries once with a fresh token if the
 * cached one was revoked.
 */
export async function countTodaysRequests(
  config: GitHubAppConfig,
  stopAt: number,
  options: { fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<number> {
  const dayStart = startOfUtcDay(options.nowMs ?? Date.now());
  try {
    return await countWithToken(config, stopAt, dayStart, options.fetchImpl);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.upstreamStatus !== 401) throw error;
    evictInstallationToken(config, READ_PERMISSIONS);
    return countWithToken(config, stopAt, dayStart, options.fetchImpl);
  }
}

/** Once the cap is hit, later attempts are refused without calling GitHub until midnight UTC. */
let capReachedUntilMs = 0;

/** Test hook: forget a remembered "cap reached" state. */
export function resetDailyCapMemory(): void {
  capReachedUntilMs = 0;
}

const limitReached = () =>
  new HttpError(
    429,
    "DAILY_LIMIT_REACHED",
    "Today's request limit has been reached. Please try again tomorrow (the limit resets at midnight UTC).",
  );

/** Throws 429 when today's cap is reached; GitHub failures propagate as 503/502 (fail closed). */
export async function assertWithinDailyCap(
  config: GitHubAppConfig,
  cap: number,
  options: { fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  if (nowMs < capReachedUntilMs) throw limitReached();
  const count = await countTodaysRequests(config, cap, { ...options, nowMs });
  if (count >= cap) {
    capReachedUntilMs = startOfUtcDay(nowMs).getTime() + 24 * 60 * 60 * 1000;
    throw limitReached();
  }
}
