/**
 * Approval gate entry point (GitHub Actions, Node 24).
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER, PORTAL_BOT_LOGIN
 * and APPROVER_ALLOWLIST. Writes `approved=true`, `approval_event_id`,
 * `plan_comment_id` and `plan_sha256` to the step outputs when the approval is
 * accepted. Logs JSON lines with outcomes only. Exits 0 for accepted, refused
 * and skipped approvals; 1 on errors, or when a refused label couldn't be
 * removed (so the workflow's fallback step can try again).
 */
import { appendFileSync } from "node:fs";

import { readAllowlist } from "../lib/allowlist.mts";
import { createGitHubClient } from "../lib/github.mts";
import type { Log } from "../planner/planner.mts";
import { checkApproval } from "./gate.mts";

const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
};

async function main(): Promise<number> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const issue = process.env.ISSUE_NUMBER?.trim() ?? "";
  const portalBotLogin = process.env.PORTAL_BOT_LOGIN?.trim() ?? "";
  if (!token || !repo || !/^[1-9]\d{0,9}$/.test(issue) || !portalBotLogin) {
    log("error", "gate.misconfigured", {
      reason: "GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER or PORTAL_BOT_LOGIN missing",
    });
    return 1;
  }
  const allowlist = readAllowlist(process.env);
  if (allowlist.rejected > 0) {
    log("warn", "gate.config_warning", { invalidAllowlistEntries: allowlist.rejected });
  }

  const outcome = await checkApproval(
    { issueNumber: Number(issue), portalBotLogin, allowlist },
    { github: createGitHubClient(repo, token), log },
  );
  if (outcome.kind === "approved" && process.env.GITHUB_OUTPUT) {
    const { approvalEventId, planCommentId, planSha256 } = outcome.approval;
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `approved=true\napproval_event_id=${approvalEventId}\nplan_comment_id=${planCommentId}\nplan_sha256=${planSha256}\n`,
    );
  }
  return outcome.kind === "refused" && !outcome.cleanedUp ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log("error", "gate.crashed", {
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof Error && "status" in error ? { status: Number(error.status) } : {}),
    });
    process.exitCode = 1;
  },
);
