/**
 * Revision and circuit-breaker entry point (GitHub Actions, Node 24). Node's
 * standard library only; each step reads only its own settings.
 *
 * REVISE_STEP selects the job:
 * - `gate` (no secrets): writes `accepted`, `label_event_id` and `head_sha`.
 * - `generate` (model key): also reads LABEL_EVENT_ID, HEAD_SHA and the LLM_*
 *   settings; the head commit must have been fetched. Writes `built`,
 *   `bundle` and `bundle_sha256`.
 * - `publish` (agent App key): also reads BUNDLE, BUNDLE_SHA256 and
 *   AGENT_APP_ID / AGENT_APP_PRIVATE_KEY.
 * - `breaker` (no secrets): reads WORKFLOW_ID and HEAD_BRANCH from the CI run.
 *
 * Always: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, AGENT_APP_LOGIN and
 * APPROVER_ALLOWLIST. Exits non-zero when a step failed.
 */
import { appendFileSync } from "node:fs";

import { readAllowlist } from "../lib/allowlist.mts";
import { installationToken, readAgentAppConfig, revokeToken } from "../lib/app-auth.mts";
import { createGitHubClient } from "../lib/github.mts";
import { createLlmClient, readLlmConfig } from "../lib/llm.mts";
import type { Log } from "../planner/planner.mts";
import { createGit } from "../scope-check/pull-request.mts";
import { checkBreaker } from "./breaker.mts";
import { readContext } from "./context.mts";
import { pushRevision } from "./publish.mts";
import {
  type ExpectedChange,
  type ReviseSettings,
  runReviseGate,
  runReviseGenerate,
  runRevisePublish,
} from "./revise.mts";

const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
};

const value = (name: string) => process.env[name]?.trim() ?? "";
const ID = /^[1-9]\d{0,15}$/;

function misconfigured(problems: string[]): number {
  log("error", "revise.misconfigured", { reason: problems.join("; ") });
  return 1;
}

async function main(): Promise<number> {
  const step = value("REVISE_STEP");
  const output = process.env.GITHUB_OUTPUT;
  const problems: string[] = [];
  if (!["gate", "generate", "publish", "breaker"].includes(step)) {
    problems.push("REVISE_STEP missing or invalid");
  }
  if (!value("GITHUB_TOKEN")) problems.push("GITHUB_TOKEN missing");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value("GITHUB_REPOSITORY"))) {
    problems.push("GITHUB_REPOSITORY missing or invalid");
  }
  if (!/^[1-9]\d{0,9}$/.test(value("PR_NUMBER"))) problems.push("PR_NUMBER missing or invalid");
  if (!value("AGENT_APP_LOGIN")) problems.push("AGENT_APP_LOGIN missing");
  if (step !== "breaker" && step !== "publish" && !output) problems.push("GITHUB_OUTPUT missing");
  if (step === "generate" || step === "publish") {
    if (!ID.test(value("LABEL_EVENT_ID"))) problems.push("LABEL_EVENT_ID missing or invalid");
    if (!/^[0-9a-f]{40}$/.test(value("HEAD_SHA"))) problems.push("HEAD_SHA missing or invalid");
  }
  if (step === "breaker") {
    if (!ID.test(value("WORKFLOW_ID"))) problems.push("WORKFLOW_ID missing or invalid");
    if (!value("HEAD_BRANCH")) problems.push("HEAD_BRANCH missing");
  }
  if (problems.length > 0) return misconfigured(problems);

  const repo = value("GITHUB_REPOSITORY");
  const github = createGitHubClient(repo, value("GITHUB_TOKEN"));
  const settings: ReviseSettings = {
    pullNumber: Number(value("PR_NUMBER")),
    repo,
    agentLogin: value("AGENT_APP_LOGIN"),
    allowlist: readAllowlist(process.env),
  };
  const expected: ExpectedChange = {
    labelEventId: Number(value("LABEL_EVENT_ID")),
    headSha: value("HEAD_SHA"),
  };

  if (step === "gate") {
    const result = await runReviseGate(settings, { github, log });
    appendFileSync(
      output as string,
      result.kind === "accepted"
        ? `accepted=true\nlabel_event_id=${result.expected.labelEventId}\nhead_sha=${result.expected.headSha}\n`
        : "accepted=false\n",
    );
    return 0;
  }
  if (step === "generate") {
    const result = await runReviseGenerate(settings, expected, {
      github,
      log,
      git: createGit(process.cwd()),
      createLlm: () => createLlmClient(readLlmConfig()),
      readContext,
    });
    if (result.kind === "built") {
      appendFileSync(
        output as string,
        `built=true\nbundle=${result.bundle}\nbundle_sha256=${result.sha256}\n`,
      );
      return 0;
    }
    appendFileSync(output as string, "built=false\n");
    return result.kind === "stopped" ? 0 : 1;
  }
  if (step === "publish") {
    // Reads and removes the key from the environment before anything else runs.
    const app = readAgentAppConfig(process.env);
    const result = await runRevisePublish(
      settings,
      expected,
      {
        github,
        log,
        // A revision only writes git data.
        token: () => installationToken(app, { contents: "write" }),
        revoke: (token) => revokeToken(token),
        push: (token, input) => pushRevision(token, input),
      },
      process.env.BUNDLE ?? "",
      process.env.BUNDLE_SHA256 ?? "",
    );
    return result.kind === "failed" ? 1 : 0;
  }
  await checkBreaker(
    {
      pullNumber: settings.pullNumber,
      workflowId: Number(value("WORKFLOW_ID")),
      branch: value("HEAD_BRANCH"),
      repo,
      agentLogin: settings.agentLogin,
    },
    { github, log },
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log("error", "revise.crashed", {
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof Error && "status" in error ? { status: Number(error.status) } : {}),
    });
    process.exitCode = 1;
  },
);
