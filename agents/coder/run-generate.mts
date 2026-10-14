/**
 * Build job 1 entry point: generate the demo (GitHub Actions, Node 24).
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER, PORTAL_BOT_LOGIN,
 * APPROVER_ALLOWLIST, the gate's APPROVAL_EVENT_ID, PLAN_COMMENT_ID and
 * PLAN_SHA256, and the LLM_* settings. Runs from the default branch's
 * checkout with nothing installed (Node's standard library only, next to the
 * model key). Writes `built`, `bundle` and `bundle_sha256` step outputs. Exits non-zero on failure (after handing
 * the request to a maintainer); a withdrawn approval is `built=false`.
 */
import { appendFileSync } from "node:fs";

import { createGitHubClient } from "../lib/github.mts";
import { createLlmClient, readLlmConfig } from "../lib/llm.mts";
import type { Log } from "../planner/planner.mts";
import { runGenerate } from "./build.mts";
import { readContext } from "./context.mts";
import { readBuildSettings } from "./settings.mts";

const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
};

async function main(): Promise<number> {
  const output = process.env.GITHUB_OUTPUT;
  const read = readBuildSettings(process.env);
  if (!output) {
    log("error", "build.misconfigured", { reason: "GITHUB_OUTPUT missing" });
    return 1;
  }
  if (!read.ok) {
    log("error", "build.misconfigured", { reason: read.problems.join("; ") });
    return 1;
  }
  const result = await runGenerate(read.settings, {
    github: createGitHubClient(read.repo, read.token),
    log,
    createLlm: () => createLlmClient(readLlmConfig()),
    readContext,
  });
  if (result.kind === "stopped") {
    // The approval was withdrawn or changed before anything happened: not a failure.
    appendFileSync(output, "built=false\n");
    return 0;
  }
  if (result.kind !== "built") return 1;
  appendFileSync(output, `built=true\nbundle=${result.bundle}\nbundle_sha256=${result.sha256}\n`);
  return 0;
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
