/**
 * Scheduled screenshot cleanup (runs in GitHub Actions on Node 24).
 *
 * 1. List stored screenshots (paged).
 * 2. Read recent issues: which screenshots are referenced anywhere (keeps
 *    them), and which portal issues link them (to replace the link).
 * 3. Delete expired screenshots after replacing their links; delete orphans.
 *
 * Dry run unless DRY_RUN is exactly "false". Logs counts only. Exits non-zero
 * on any failure so the workflow fails and the maintainer is notified.
 */
import { del, list } from "@vercel/blob";

import {
  type StoredScreenshot,
  issueScanSince,
  linkedPathnames,
  planCleanup,
  readPositiveInt,
  referencedPathnames,
} from "./core.mts";
import { executeCleanup } from "./execute.mts";
import { type IssueSummary, getIssueBody, listIssuesSince, updateIssueBody } from "./github.mts";

const MAX_LIST_PAGES = 100;
let stage = "start";

function report(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
}

async function listScreenshots(token: string): Promise<StoredScreenshot[]> {
  const blobs: StoredScreenshot[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await list({ prefix: "screenshots/", cursor, limit: 1000, token });
    blobs.push(
      ...result.blobs.map(({ url, pathname, uploadedAt }) => ({ url, pathname, uploadedAt })),
    );
    if (!result.hasMore) return blobs;
    cursor = result.cursor;
  }
  throw new Error("too many stored screenshots to scan safely");
}

/** Portal-created issues: bot-authored with the request label (and the exact bot login when configured). */
function isPortalIssue(issue: IssueSummary): boolean {
  const botLogin = process.env.PORTAL_BOT_LOGIN;
  return (
    issue.authorType === "Bot" &&
    issue.labels.includes("portal-request") &&
    (!botLogin || issue.authorLogin === botLogin)
  );
}

async function main(): Promise<number> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    if (process.env.CLEANUP_REQUIRED === "true") {
      report("error", "cleanup.misconfigured", { reason: "BLOB_READ_WRITE_TOKEN missing" });
      return 1;
    }
    console.log("::notice::BLOB_READ_WRITE_TOKEN is not configured; nothing to clean up.");
    return 0;
  }
  const githubToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!githubToken || !repo) {
    report("error", "cleanup.misconfigured", {
      reason: "GITHUB_TOKEN or GITHUB_REPOSITORY missing",
    });
    return 1;
  }
  const dryRun = process.env.DRY_RUN !== "false";
  const retentionDays = readPositiveInt(process.env.RETENTION_DAYS, 90, 3650);
  const orphanGraceHours = readPositiveInt(process.env.ORPHAN_GRACE_HOURS, 24, 24 * 30);
  const nowMs = Date.now();

  stage = "list_screenshots";
  const blobs = await listScreenshots(blobToken);

  stage = "read_issues";
  // Covers every issue that could link a file still in the store.
  const since = issueScanSince(blobs, nowMs, retentionDays).toISOString();
  let issues: IssueSummary[] | null = null;
  try {
    issues = await listIssuesSince(repo, githubToken, since);
  } catch (error) {
    report("warn", "cleanup.issue_lookup_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  const referenced = issues
    ? new Set(issues.flatMap((issue) => referencedPathnames(issue.body)))
    : null;
  let linking: Map<string, number[]> | null = null;
  if (issues) {
    linking = new Map();
    for (const issue of issues.filter(isPortalIssue)) {
      for (const pathname of linkedPathnames(issue.body)) {
        linking.set(pathname, [...(linking.get(pathname) ?? []), issue.number]);
      }
    }
  }

  stage = "plan";
  const plan = planCleanup({ blobs, referenced, nowMs, retentionDays, orphanGraceHours });

  stage = "execute";
  const result = await executeCleanup(
    plan,
    linking,
    {
      getIssueBody: (number) => getIssueBody(repo, githubToken, number),
      updateIssueBody: (number, body) => updateIssueBody(repo, githubToken, number, body),
      deleteBlobs: (urls) => del(urls, { token: blobToken }),
    },
    dryRun,
  );

  report(result.failures ? "error" : "info", "cleanup.finished", {
    dryRun,
    scanned: blobs.length,
    expired: plan.expired.length,
    orphans: plan.orphans.length,
    referencesKnown: issues !== null,
    ...result,
  });
  return result.failures ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    report("error", "cleanup.crashed", {
      stage,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    process.exitCode = 1;
  },
);
