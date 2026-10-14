/**
 * The automated review of the coding agent's request pull requests. It reads
 * the plan the build was made from (on the request issue) and the demo's
 * files at the pushed head (git objects only; nothing from the pull request is
 * checked out or run), asks the model for a verdict and posts it once per
 * commit, next to the coding agent's own file checks. The review is advisory:
 * it approves nothing and changes nothing, and findings wait for a maintainer. If it can't finish, it says so in a short,
 * fixed comment; details go to the log as kinds and statuses, never content.
 */
import { BUILD_MARKER } from "../gate/gate.mts";
import type { Comment, GitHubClient } from "../lib/github.mts";
import { type ChatMessage, type LlmClient, LlmError } from "../lib/llm.mts";
import { DEMO_FILE, LOADER_FILE, PAGE_FILE } from "../coder/template.mts";
import {
  type GeneratedFile,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  validateFiles,
} from "../coder/files.mts";
import { extractPlanText } from "../planner/plan.mts";
import { type Log, agentPlanComments, byAgent } from "../planner/planner.mts";
import { RETRY_INSTRUCTION } from "../planner/prompt.mts";
import { isAllowedDemoPath } from "../planner/scope.mts";
import { type PullRequestInfo, classify, isSha } from "../scope-check/check.mts";
import type { Git } from "../scope-check/pull-request.mts";
import {
  REVIEW_MARKER,
  buildReviewMessages,
  parseReview,
  renderReviewComment,
  reviewMarker,
} from "./review.mts";

export interface ReviewSettings {
  pullNumber: number;
  headSha: string;
  pull: PullRequestInfo;
}

export interface ReviewDeps {
  github: GitHubClient;
  git: Git;
  log: Log;
  createLlm: () => LlmClient;
  readAgentsGuide: () => Promise<string>;
}

export type ReviewOutcome = "skipped" | "reviewed" | "error";

export type ErrorReason = "no_plan" | "unreadable_files" | "unusable_reply" | "llm";

const ERRORS: Record<ErrorReason, string> = {
  no_plan: "The approved plan for this request couldn't be found unchanged on the request issue.",
  unreadable_files: "The demo's files couldn't be read for review.",
  unusable_reply: "The model didn't return a usable review.",
  llm: "The model couldn't be reached or isn't configured, or the run's token budget ran out.",
};

export function renderReviewError(reason: ErrorReason, head: string, detail?: string): string {
  return [
    reviewMarker("error", head),
    "### Automated review: not completed",
    "",
    `${ERRORS[reason]}${detail ? ` ${detail}` : ""} A maintainer reviews the pull request as usual.`,
  ].join("\n");
}

const MAX_OUTPUT_TOKENS = 4_000;
const CALL_TIMEOUT_MS = 180_000;

/**
 * The plan the latest build was made from: the agent's last plan comment
 * before its last build comment (what the approval gate checked), unedited.
 */
export function builtPlan(comments: Comment[]): string | null {
  const build = comments.findLastIndex((c) => byAgent(c) && BUILD_MARKER.test(c.body));
  if (build === -1) return null;
  const plan = agentPlanComments(comments.slice(0, build)).at(-1);
  if (!plan || plan.updatedAt !== plan.createdAt) return null;
  return extractPlanText(plan.body);
}

const ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(\d+|-)\t(.+)$/;

/**
 * The demo's own files at `head` (the page and loader are the workflow's
 * templates, checked by the write-scope check), or a fixed problem. Anything
 * the write-scope rules wouldn't allow is a problem, not skipped, and so is
 * anything over the limits the coding agent's files are held to.
 */
export async function readDemoFiles(
  git: Git,
  head: string,
  slug: string,
): Promise<{ files: GeneratedFile[] } | { problem: string }> {
  const dir = `src/app/demos/${slug}/`;
  const listing = await git.text(["ls-tree", "-r", "-l", "-z", "--full-tree", head, "--", dir]);
  const entries = listing.split("\0").filter(Boolean);
  const wanted: { blob: string; path: string }[] = [];
  let total = 0;
  for (const entry of entries) {
    const match = ENTRY.exec(entry);
    if (!match) return { problem: "Git listed something unexpected." };
    const [, mode, type, blob, size, path] = match;
    if (mode !== "100644" || type !== "blob" || !isAllowedDemoPath(path, slug)) {
      return { problem: "The demo folder holds files the write-scope rules don't allow." };
    }
    if (path === `${dir}${PAGE_FILE}` || path === `${dir}${LOADER_FILE}`) continue;
    const bytes = Number(size);
    total += bytes;
    if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || wanted.length === MAX_FILES) {
      return { problem: "They're too large for an automated review." };
    }
    wanted.push({ blob, path });
  }
  if (!wanted.some((file) => file.path === `${dir}${DEMO_FILE}`)) {
    return { problem: `There's no ${DEMO_FILE}.` };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: GeneratedFile[] = [];
  for (const { blob, path } of wanted) {
    try {
      files.push({ path, content: decoder.decode(await git.bytes(["cat-file", "blob", blob])) });
    } catch {
      return { problem: "Some of them aren't UTF-8 text." };
    }
  }
  // The demo first, then the rest in path order (as listed).
  files.sort(
    (a, b) => Number(b.path.endsWith(`/${DEMO_FILE}`)) - Number(a.path.endsWith(`/${DEMO_FILE}`)),
  );
  return { files };
}

/** The model's review, or null if it gave no usable one (one retry). */
async function askForReview(llm: LlmClient, messages: ChatMessage[]) {
  for (const attempt of [messages, [...messages, { role: "user", content: RETRY_INSTRUCTION }]]) {
    // Provider-default temperature: some models reject anything else.
    const reply = await llm.chat(attempt as ChatMessage[], {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    // A reply cut off or filtered would be again.
    if (reply.finishReason !== "stop" && reply.finishReason !== "unknown") return null;
    const review = parseReview(reply.text);
    if (review) return review;
  }
  return null;
}

export async function reviewPullRequest(
  settings: ReviewSettings,
  deps: ReviewDeps,
): Promise<ReviewOutcome> {
  const { github, log } = deps;
  const { pullNumber, headSha } = settings;
  const kind = classify(settings.pull);
  // Not the agent's request pull request (the write-scope check reports bad shapes).
  if (kind.kind !== "request") {
    log("info", "review.skipped", { pull: pullNumber, reason: "not_a_request_pull" });
    return "skipped";
  }
  if (!isSha(headSha)) {
    log("info", "review.skipped", { pull: pullNumber, reason: "invalid_head" });
    return "skipped";
  }
  const issueNumber = Number(settings.pull.headRef.slice("request-".length));

  // Only unedited reviews count, so an edited comment can't stand in for one.
  const reviewed = (await github.listComments(pullNumber)).some((comment) => {
    const fields =
      byAgent(comment) && comment.updatedAt === comment.createdAt
        ? REVIEW_MARKER.exec(comment.body)
        : null;
    return fields !== null && fields[1] !== "error" && fields[2] === headSha;
  });
  if (reviewed) {
    log("info", "review.skipped", { pull: pullNumber, reason: "already_reviewed" });
    return "skipped";
  }

  const fail = async (reason: ErrorReason, detail?: string) => {
    log("warn", "review.failed", { pull: pullNumber, reason });
    await github.createComment(pullNumber, renderReviewError(reason, headSha, detail));
    return "error" as const;
  };

  const planText = builtPlan(await github.listComments(issueNumber));
  if (planText === null) return fail("no_plan");
  const read = await readDemoFiles(deps.git, headSha, kind.slug);
  if ("problem" in read) return fail("unreadable_files", read.problem);

  const checks = validateFiles(read.files, kind.slug);
  const messages = buildReviewMessages({
    slug: kind.slug,
    agentsGuide: await deps.readAgentsGuide(),
    planText,
    files: read.files,
  });
  let review;
  try {
    review = await askForReview(deps.createLlm(), messages);
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    log("warn", "review.llm_error", { pull: pullNumber, kind: error.kind });
    return fail("llm");
  }
  if (!review) return fail("unusable_reply");
  await github.createComment(pullNumber, renderReviewComment(review, checks, headSha, kind.slug));
  log("info", "review.posted", {
    pull: pullNumber,
    result: review.result,
    findings: review.findings.length + review.omitted,
    checks: checks.length,
  });
  return "reviewed";
}
