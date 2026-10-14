/**
 * Build job 2 entry point: publish the demo (GitHub Actions, Node 24).
 *
 * Environment: GITHUB_TOKEN (issue comments), GITHUB_REPOSITORY, ISSUE_NUMBER,
 * PORTAL_BOT_LOGIN, APPROVER_ALLOWLIST, the gate's APPROVAL_EVENT_ID,
 * PLAN_COMMENT_ID and PLAN_SHA256, the generate job's BUNDLE and
 * BUNDLE_SHA256, and AGENT_APP_ID / AGENT_APP_PRIVATE_KEY. No dependencies
 * are installed in this job. Exits non-zero unless a pull request was opened.
 */
import { createGitHubClient } from "../lib/github.mts";
import { installationToken, readAgentAppConfig, revokeToken } from "../lib/app-auth.mts";
import type { Log } from "../planner/planner.mts";
import { runPublish } from "./build.mts";
import { publishDemo } from "./publish.mts";
import { readBuildSettings } from "./settings.mts";

const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
};

async function main(): Promise<number> {
  const read = readBuildSettings(process.env);
  const bundle = process.env.BUNDLE ?? "";
  const sha256 = process.env.BUNDLE_SHA256 ?? "";
  if (!read.ok) {
    log("error", "build.misconfigured", { reason: read.problems.join("; ") });
    return 1;
  }
  // Reads and removes the key from the environment before anything else runs.
  const app = readAgentAppConfig(process.env);
  const result = await runPublish(
    read.settings,
    {
      github: createGitHubClient(read.repo, read.token),
      log,
      token: () => installationToken(app, { contents: "write", pull_requests: "write" }),
      revoke: (token) => revokeToken(token),
      publish: (token, input) => publishDemo(token, input),
    },
    read.repo,
    bundle,
    sha256,
  );
  return result.kind === "published" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log("error", "build.crashed", {
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof Error && "status" in error ? { status: Number(error.status) } : {}),
    });
    process.exitCode = 1;
  },
);
