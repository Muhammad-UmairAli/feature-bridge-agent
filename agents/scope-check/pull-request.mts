/**
 * Runs the write-scope rules against a pull request's commits, read through
 * git as data (nothing from the pull request is checked out or executed).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type PullRequestInfo,
  checkChanges,
  checkContent,
  classify,
  isSha,
  parseRawLog,
  shown,
} from "./check.mts";

export interface Git {
  /** Run git and return stdout as text. */
  text(args: string[]): Promise<string>;
  /** Run git and return stdout as bytes (for blob contents). */
  bytes(args: string[]): Promise<Uint8Array>;
}

const run = promisify(execFile);

/** Git in `cwd`, with a minimal environment and settings that don't depend on the runner. */
export function createGit(cwd: string): Git {
  const options = {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_ENV: "production" as const,
    },
    maxBuffer: 64 * 1024 * 1024,
  };
  const args = (rest: string[]) => ["-c", "core.quotePath=false", ...rest];
  return {
    async text(rest) {
      return (await run("git", args(rest), { ...options, encoding: "utf8" })).stdout;
    },
    async bytes(rest) {
      return (await run("git", args(rest), { ...options, encoding: "buffer" })).stdout;
    },
  };
}

export interface Result {
  /** True when the pull request isn't a request branch (no rules apply). */
  skipped: boolean;
  checked: number;
  problems: string[];
}

export async function checkPullRequest(
  pr: PullRequestInfo,
  baseSha: string,
  headSha: string,
  git: Git,
): Promise<Result> {
  const kind = classify(pr);
  if (kind.kind === "other") return { skipped: true, checked: 0, problems: [] };
  if (kind.kind === "refused") return { skipped: false, checked: 0, problems: kind.problems };
  const { slug } = kind;
  if (!isSha(baseSha) || !isSha(headSha)) {
    return { skipped: false, checked: 0, problems: ["the base and head must be full commit ids"] };
  }

  const problems: string[] = [];
  const range = `${baseSha}..${headSha}`;
  const merges = (await git.text(["rev-list", "--min-parents=2", range]))
    .split("\n")
    .filter(Boolean);
  if (merges.length > 0) {
    problems.push(`merge commits aren't allowed on request branches: ${merges.join(", ")}`);
  }
  // Each request builds a new demo; changing one that's already live needs a human.
  const existing = await git.text([
    "ls-tree",
    "-d",
    "--name-only",
    baseSha,
    `src/app/demos/${slug}`,
  ]);
  if (existing.trim()) problems.push(`src/app/demos/${slug}/ already exists on the base branch`);

  // The pull request must leave a demo behind: its page at the head.
  const page = await git.text([
    "ls-tree",
    "--name-only",
    headSha,
    `src/app/demos/${slug}/page.tsx`,
  ]);
  if (!page.trim()) problems.push(`src/app/demos/${slug}/page.tsx is missing at the head`);

  const changes = parseRawLog(
    await git.text([
      "log",
      "--raw",
      "-z",
      "--no-abbrev",
      "--no-renames",
      "--no-relative",
      "--ignore-submodules=none",
      "--format=",
      range,
    ]),
  );
  const pathProblems = checkChanges(changes, slug);
  problems.push(...pathProblems);

  // Every file version the pull request adds at an allowed path. Sizes count
  // once per added path and version (identical files still add up); contents
  // are read once per blob.
  const added = changes.filter(
    (change) =>
      (change.status === "A" || change.status === "M") &&
      /^[0-9a-f]{40}$/.test(change.newBlob) &&
      !pathProblems.some((p) => p.startsWith(shown(change.path))),
  );
  const sizes = new Map<string, number>();
  let total = 0;
  for (const change of added) {
    if (!sizes.has(change.newBlob)) {
      sizes.set(
        change.newBlob,
        Number((await git.text(["cat-file", "-s", change.newBlob])).trim()),
      );
    }
    total += sizes.get(change.newBlob) ?? 0;
  }
  if (total > MAX_TOTAL_BYTES) {
    problems.push(`the pull request adds more than ${MAX_TOTAL_BYTES} bytes of files`);
  }
  const read = new Set<string>();
  for (const change of added) {
    if (read.has(change.newBlob)) continue;
    read.add(change.newBlob);
    const size = sizes.get(change.newBlob) ?? 0;
    if (size > MAX_FILE_BYTES) {
      problems.push(`${shown(change.path)}: larger than ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    problems.push(
      ...checkContent(change.path, await git.bytes(["cat-file", "blob", change.newBlob])),
    );
  }
  return { skipped: false, checked: changes.length, problems };
}
