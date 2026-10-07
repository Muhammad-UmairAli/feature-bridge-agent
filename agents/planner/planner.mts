/**
 * Plan one request issue: check it came from the portal, read the untrusted
 * description, ask the model for a plan, and post it. On any failure the
 * request is handed to a maintainer (`needs-human-triage`) with a short,
 * fixed comment; error details go to the workflow log as kinds and statuses,
 * never content.
 *
 * Runs for the same issue must not overlap (the workflow serialises them per
 * issue); a re-run after a crash simply plans again.
 */
import { type Comment, GitHubApiError, type GitHubClient } from "../lib/github.mts";
import { type ChatMessage, type LlmClient, LlmError } from "../lib/llm.mts";
import { PLAN_MARKER, type Plan, STOPPED_MARKER, parsePlan, renderPlanComment } from "./plan.mts";
import { RETRY_INSTRUCTION, buildPlanMessages } from "./prompt.mts";
import {
  DESCRIPTION_MAX_CODE_POINTS,
  LABELS,
  codePoints,
  demoSlug,
  isPortalIssue,
  parseRequestBody,
  requestHash,
} from "./request.mts";

/** Comments made with the workflow's GITHUB_TOKEN are authored by this bot. */
export const AGENT_LOGIN = "github-actions[bot]";
const MAX_OUTPUT_TOKENS = 4_000;
const CALL_TIMEOUT_MS = 120_000;

export type ScreenshotState = "available" | "missing" | "unknown";
export type Log = (
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, string | number | boolean>,
) => void;

export interface PlannerDeps {
  github: GitHubClient;
  /** Reads the LLM configuration; throws a `config` LlmError when it is missing or invalid. */
  createLlm: () => LlmClient;
  readContext: () => Promise<{ agentsGuide: string; repoFiles: string[] }>;
  checkScreenshot: (url: string) => Promise<ScreenshotState>;
  log: Log;
}

export interface PlannerSettings {
  issueNumber: number;
  portalBotLogin: string;
  /** Send the screenshot to the model (LLM_IMAGE_INPUT=on); needs a model that accepts images. */
  imageInput: boolean;
}

export type PlannerOutcome = "skipped" | "planned" | "failed";

/** The agent's own plan comments (marker at the start, authored by the workflow bot). */
export function agentPlanComments(comments: Comment[]): Comment[] {
  return comments.filter(
    (comment) =>
      comment.user?.type === "Bot" &&
      comment.user.login === AGENT_LOGIN &&
      PLAN_MARKER.test(comment.body),
  );
}

class PlanningFailure extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "PlanningFailure";
    this.reason = reason;
  }
}

/** What the failure comment says; fixed text, so nothing untrusted is echoed. */
function failureText(error: unknown): { reason: string; text: string } {
  if (error instanceof PlanningFailure) return { reason: error.reason, text: error.message };
  if (error instanceof LlmError) {
    if (error.kind === "cap_exceeded") {
      return {
        reason: "cap_exceeded",
        text: "The planning agent stopped because this request reached its token budget.",
      };
    }
    if (error.kind === "config") {
      return { reason: "config", text: "The planning agent isn't configured correctly." };
    }
    return { reason: `llm_${error.kind}`, text: "The planning agent couldn't reach the model." };
  }
  if (error instanceof GitHubApiError) {
    return { reason: "github", text: "The planning agent couldn't update this issue." };
  }
  return { reason: "unexpected", text: "The planning agent hit an unexpected error." };
}

async function askForPlan(llm: LlmClient, messages: ChatMessage[]): Promise<Plan> {
  for (const attempt of [messages, [...messages, { role: "user", content: RETRY_INSTRUCTION }]]) {
    // Provider-default temperature: some models reject anything else.
    const reply = await llm.chat(attempt as ChatMessage[], {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    if (reply.finishReason === "length") {
      // Asking again with the same limit would be cut off again.
      throw new PlanningFailure("reply_truncated", "The model's plan was too long.");
    }
    const plan = parsePlan(reply.text);
    if (plan) return plan;
    // The retry repeats the request without the unusable reply.
  }
  throw new PlanningFailure("unusable_reply", "The model didn't return a usable plan.");
}

export async function planRequest(
  settings: PlannerSettings,
  deps: PlannerDeps,
): Promise<PlannerOutcome> {
  const { github, log } = deps;
  const number = settings.issueNumber;
  const issue = await github.getIssue(number);

  if (!isPortalIssue(issue, settings.portalBotLogin)) {
    log("info", "planner.skipped", { issue: number, reason: "not_a_portal_request" });
    return "skipped";
  }
  if (issue.labels.includes(LABELS.needsHumanTriage) || issue.labels.includes(LABELS.approved)) {
    log("info", "planner.skipped", { issue: number, reason: "already_decided" });
    return "skipped";
  }

  let llm: LlmClient | null = null;
  let plan: Plan;
  let image = false;
  try {
    if (agentPlanComments(await github.listComments(number)).length > 0) {
      log("info", "planner.skipped", { issue: number, reason: "already_planned" });
      return "skipped";
    }
    await github.addLabels(number, [LABELS.planning]);

    const request = parseRequestBody(issue.body);
    if (request === null) {
      throw new PlanningFailure("unreadable_request", "The request text couldn't be read.");
    }
    if (codePoints(request.description) > DESCRIPTION_MAX_CODE_POINTS) {
      throw new PlanningFailure("request_too_long", "The request text is longer than allowed.");
    }

    const notes: string[] = [];
    let screenshotUrl: string | null = null;
    if (request.screenshotUrl && settings.imageInput) {
      const state = await deps.checkScreenshot(request.screenshotUrl);
      if (state === "available") screenshotUrl = request.screenshotUrl;
      else if (state === "missing") {
        notes.push("The screenshot has been removed, so this plan uses the description only.");
      } else {
        notes.push("The screenshot couldn't be checked, so this plan uses the description only.");
      }
    } else if (request.screenshotUrl) {
      notes.push(
        "Screenshots aren't sent to the model on this deployment; this plan uses the description only.",
      );
    }
    image = screenshotUrl !== null;

    const context = await deps.readContext();
    const slug = demoSlug(number);
    llm = deps.createLlm();
    plan = await askForPlan(
      llm,
      buildPlanMessages({ description: request.description, slug, ...context, screenshotUrl }),
    );
    await github.createComment(
      number,
      renderPlanComment({
        plan,
        revision: 1,
        slug,
        requestHash: requestHash(request.description),
        notes,
      }),
    );
  } catch (error) {
    const { reason, text } = failureText(error);
    log("error", "planner.failed", {
      issue: number,
      reason,
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof LlmError ? { kind: error.kind } : {}),
      ...(error instanceof GitHubApiError ? { status: error.status } : {}),
      ...(llm ? { tokens: llm.tokensUsed } : {}),
    });
    // Best effort: each step is attempted even if an earlier one fails.
    await bestEffort(log, number, [
      () =>
        github.createComment(
          number,
          `${STOPPED_MARKER}\n### Planning stopped\n\n${text} A maintainer will take it from here.`,
        ),
      () => github.removeLabel(number, LABELS.planning),
      () => github.addLabels(number, [LABELS.needsHumanTriage]),
    ]);
    return "failed";
  }

  // The plan is public now: a label problem must not contradict it, so it only
  // fails the run (which notifies the maintainer).
  const labelled = await bestEffort(log, number, [
    () => github.removeLabel(number, LABELS.planning),
    () => github.addLabels(number, [LABELS.planReady]),
  ]);
  log(labelled ? "info" : "error", "planner.planned", {
    issue: number,
    files: plan.files.length,
    tokens: llm.tokensUsed,
    image,
    flaggedInstructions: plan.instructionsInRequest,
    labelled,
  });
  return labelled ? "planned" : "failed";
}

/** Run each step even if earlier ones fail; true when all succeeded. */
async function bestEffort(
  log: Log,
  issue: number,
  steps: (() => Promise<void>)[],
): Promise<boolean> {
  let ok = true;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      ok = false;
      log("error", "planner.cleanup_failed", {
        issue,
        ...(error instanceof GitHubApiError ? { status: error.status } : {}),
      });
    }
  }
  return ok;
}
