/**
 * Planning agent entry point (GitHub Actions, Node 24).
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER, PORTAL_BOT_LOGIN,
 * the LLM_* settings, and optionally LLM_IMAGE_INPUT=on. Logs JSON lines with
 * counts and outcomes only. Exits non-zero when planning failed, so the run
 * shows as failed and the maintainer is notified.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { createGitHubClient } from "../lib/github.mts";
import { createLlmClient, readLlmConfig } from "../lib/llm.mts";
import { type Log, planRequest } from "./planner.mts";
import { checkScreenshot, readPlannerSettings } from "./settings.mts";

const MAX_GUIDE_CHARS = 40_000;

const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") console.log(line);
  else console.error(line);
};

/** AGENTS.md and the tracked files under src/, from the checked-out default branch. */
async function readContext() {
  const agentsGuide = await readFile("AGENTS.md", "utf8");
  // Never plan with part of the rules.
  if (agentsGuide.length > MAX_GUIDE_CHARS) throw new Error("AGENTS.md is too long to send");
  // A minimal environment: git doesn't need the job's secrets.
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z", "--", "src"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return { agentsGuide, repoFiles: stdout.split("\0").filter(Boolean) };
}

async function main(): Promise<number> {
  const read = readPlannerSettings(process.env);
  if (!read.ok) {
    log("error", "planner.misconfigured", { reason: read.problems.join("; ") });
    return 1;
  }
  for (const warning of read.warnings) log("warn", "planner.config_warning", { reason: warning });
  const { token, repo, ...settings } = read.settings;

  const outcome = await planRequest(settings, {
    github: createGitHubClient(repo, token),
    createLlm: () => createLlmClient(readLlmConfig()),
    readContext,
    checkScreenshot: (url) => checkScreenshot(url),
    log,
  });
  return outcome === "failed" ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log("error", "planner.crashed", {
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof Error && "status" in error ? { status: Number(error.status) } : {}),
    });
    process.exitCode = 1;
  },
);
