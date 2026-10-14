/**
 * Automated review entry point (GitHub Actions, Node 24). Runs on
 * `pull_request_target` from the base branch's code, with the pull request's
 * head commit fetched as git objects only. Node's standard library only, next
 * to the model key.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, HEAD_REF,
 * HEAD_REPO, BASE_REPO, BASE_REF, PR_AUTHOR (from the event), the
 * AGENT_APP_LOGIN repository variable, and the LLM_* settings. Exits non-zero
 * when the review couldn't be completed (after saying so on the pull request).
 */
import { readFile } from "node:fs/promises";

import { createGitHubClient } from "../lib/github.mts";
import { createLlmClient, readLlmConfig } from "../lib/llm.mts";
import type { Log } from "../planner/planner.mts";
import { createGit } from "../scope-check/pull-request.mts";
import { reviewPullRequest } from "./reviewer.mts";

const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
};

async function main(): Promise<number> {
  const env = (name: string) => process.env[name]?.trim() ?? "";
  const token = env("GITHUB_TOKEN");
  const repo = env("GITHUB_REPOSITORY");
  const pullNumber = env("PR_NUMBER");
  if (!token || !/^[1-9]\d{0,9}$/.test(pullNumber)) {
    log("error", "review.misconfigured", { reason: "GITHUB_TOKEN or PR_NUMBER missing" });
    return 1;
  }
  const outcome = await reviewPullRequest(
    {
      pullNumber: Number(pullNumber),
      headSha: env("HEAD_SHA"),
      pull: {
        headRef: env("HEAD_REF"),
        headRepo: env("HEAD_REPO"),
        baseRepo: env("BASE_REPO"),
        baseRef: env("BASE_REF"),
        author: env("PR_AUTHOR"),
        agentLogin: env("AGENT_APP_LOGIN"),
      },
    },
    {
      github: createGitHubClient(repo, token),
      git: createGit(process.cwd()),
      log,
      createLlm: () => createLlmClient(readLlmConfig()),
      readAgentsGuide: () => readFile("AGENTS.md", "utf8"),
    },
  );
  return outcome === "error" ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log("error", "review.crashed", {
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof Error && "status" in error ? { status: Number(error.status) } : {}),
    });
    process.exitCode = 1;
  },
);
