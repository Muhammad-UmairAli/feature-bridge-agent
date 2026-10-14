/**
 * Plan one request issue: check it came from the portal, read the untrusted
 * description, ask the model for a plan, and post it. On any failure the
 * request is handed to a maintainer (`needs-human-triage`) with a short,
 * fixed comment; error details go to the workflow log as kinds and statuses,
 * never content.
 *
 * In "revise" mode (an allowlisted maintainer applied `changes-requested`)
 * it reads their feedback since the latest plan and posts a revised plan; the
 * second time a plan is sent back (or a revision failed), the request goes to
 * a maintainer instead. Who applied the label is read from the issue's event
 * history, not the triggering payload, so a re-run can't replay an old sender.
 *
 * Runs for the same issue must not overlap (the workflow serialises them per
 * issue). Re-running a failed run retries it.
 */
import {
  type Allowlist,
  type GitHubAccount,
  STEERING_ROLES,
  isAllowlisted,
} from "../lib/allowlist.mts";
import {
  type Comment,
  GitHubApiError,
  type GitHubClient,
  type Issue,
  type LabelEvent,
} from "../lib/github.mts";
import { type ChatMessage, type LlmClient, LlmError } from "../lib/llm.mts";
import {
  PLAN_MARKER,
  type Plan,
  STOPPED_MARKER,
  extractPlanText,
  parsePlan,
  renderPlanComment,
} from "./plan.mts";
import { type PromptInput, RETRY_INSTRUCTION, buildPlanMessages } from "./prompt.mts";
import {
  DESCRIPTION_MAX_CODE_POINTS,
  INVISIBLE,
  LABELS,
  codePoints,
  demoSlug,
  isPortalIssue,
  parseRequestBody,
  requestHash,
} from "./request.mts";
import { type ScopeCheck, checkScope } from "./scope.mts";

/** Comments made with the workflow's GITHUB_TOKEN are authored by this bot (login and id). */
export const AGENT_LOGIN = "github-actions[bot]";
export const AGENT_ID = 41898282;
/** A plan can be revised once; the next change request goes to a maintainer. */
const MAX_PLANS = 2;
const MAX_FEEDBACK_COMMENTS = 5;
const MAX_FEEDBACK_CODE_POINTS = 2_000;
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
  /** Called once the run has accepted the request (and, for revisions, who sent it back). */
  accept?: () => void;
}

export interface PlannerSettings {
  issueNumber: number;
  portalBotLogin: string;
  /** Send the screenshot to the model (LLM_IMAGE_INPUT=on); needs a model that accepts images. */
  imageInput: boolean;
  /** "plan" (default) for a new request; "revise" after `changes-requested`. */
  mode?: "plan" | "revise";
  /** Revise mode: who may send plans back (APPROVER_ALLOWLIST). */
  allowlist?: Allowlist;
}

/** `handed_over`: sent back twice; `waiting`: asked the maintainer for feedback. */
export type PlannerOutcome = "skipped" | "planned" | "failed" | "handed_over" | "waiting";

export const byAgent = (comment: Comment) =>
  comment.user?.type === "Bot" &&
  comment.user.login === AGENT_LOGIN &&
  comment.user.id === AGENT_ID;

/** The agent's own plan comments (marker at the start, authored by the workflow bot). */
export function agentPlanComments(comments: Comment[]): Comment[] {
  return comments.filter((comment) => byAgent(comment) && PLAN_MARKER.test(comment.body));
}

/**
 * Feedback as the maintainer sees it rendered: no hidden HTML comments, no
 * quoted lines (often the public request, via "Quote reply"), no invisible
 * characters; capped in length.
 */
export function cleanFeedback(body: string): string {
  const visible = body
    .normalize("NFC")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(INVISIBLE, "")
    .trim();
  return Array.from(visible).slice(0, MAX_FEEDBACK_CODE_POINTS).join("");
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
  if (settings.mode === "revise") return revise(issue, settings, deps);

  try {
    if (agentPlanComments(await github.listComments(number)).length > 0) {
      log("info", "planner.skipped", { issue: number, reason: "already_planned" });
      return "skipped";
    }
  } catch (error) {
    return fail(number, error, deps, null);
  }
  return draftAndPost(issue, settings, deps, { revision: 1 });
}

/** Revise mode: check who sent the plan back, then revise, ask for feedback, or hand over. */
async function revise(
  issue: Issue,
  settings: PlannerSettings,
  deps: PlannerDeps,
): Promise<PlannerOutcome> {
  const { github, log } = deps;
  const number = issue.number;
  const allowlist = settings.allowlist ?? { logins: new Set<string>(), rejected: 0 };
  const skip = (reason: string): PlannerOutcome => {
    log("info", "planner.skipped", { issue: number, reason });
    return "skipped";
  };
  /** An unauthorised label would block the next real one (adding a present label fires nothing). */
  const refuse = async (reason: string) => {
    await bestEffort(log, number, [() => github.removeLabel(number, LABELS.changesRequested)]);
    return skip(reason);
  };
  if (!issue.labels.includes(LABELS.changesRequested)) return skip("label_removed");

  const roles = new Map<string, boolean>();
  /** Allowlisted, a User, and still holding triage access (usernames can be re-registered). */
  const maySteer = async (account: GitHubAccount | null | undefined) => {
    if (!isAllowlisted(allowlist, account)) return false;
    const login = String(account?.login).toLowerCase();
    if (!roles.has(login)) roles.set(login, STEERING_ROLES.has(await github.getRole(login)));
    return roles.get(login) === true;
  };

  let plans: Comment[];
  let feedback: string[];
  let previousPlan: string;
  try {
    const labelled: LabelEvent | null = await github.latestLabelEvent(
      number,
      LABELS.changesRequested,
    );
    if (!labelled) return skip("label_removed");
    if (!isAllowlisted(allowlist, labelled.actor)) return refuse("sender_not_allowed");
    if (!(await maySteer(labelled.actor))) return refuse("sender_without_access");
    deps.accept?.();

    const comments = await github.listComments(number);
    plans = agentPlanComments(comments);
    if (plans.length === 0) return skip("nothing_to_revise");
    // Failed revisions count as rounds too, so a request can't be retried forever.
    const first = comments.indexOf(plans[0]);
    const stopped = comments
      .slice(first + 1)
      .filter((comment) => byAgent(comment) && comment.body.startsWith(STOPPED_MARKER)).length;
    if (plans.length + stopped >= MAX_PLANS) {
      const ok = await bestEffort(log, number, [
        () => github.addLabels(number, [LABELS.needsHumanTriage]),
        () => github.removeLabel(number, LABELS.planReady),
        () => github.createComment(number, SENT_BACK_AGAIN),
      ]);
      log(ok ? "info" : "error", "planner.handed_over", {
        issue: number,
        plans: plans.length,
        stopped,
      });
      return ok ? "handed_over" : "failed";
    }

    const latest = plans[plans.length - 1];
    feedback = await collectFeedback(
      comments.slice(comments.indexOf(latest) + 1),
      labelled,
      maySteer,
    );
    if (feedback.length === 0) {
      const ok = await bestEffort(log, number, [
        () => github.createComment(number, FEEDBACK_NEEDED),
        () => github.removeLabel(number, LABELS.changesRequested),
      ]);
      log(ok ? "info" : "error", "planner.waiting_for_feedback", { issue: number });
      return ok ? "waiting" : "failed";
    }
    const text = extractPlanText(latest.body);
    if (text === null) {
      throw new PlanningFailure("unreadable_plan", "The previous plan couldn't be read.");
    }
    previousPlan = text.normalize("NFC").replace(INVISIBLE, "");
  } catch (error) {
    return fail(number, error, deps, null);
  }

  return draftAndPost(issue, settings, deps, {
    revision: plans.length + 1,
    revisionInput: { previousPlan, feedback },
    removeOnStart: [LABELS.planReady],
    removeOnSuccess: [LABELS.changesRequested],
  });
}

const SENT_BACK_AGAIN = `${STOPPED_MARKER}\n### Planning stopped\n\nThe plan was sent back again, so the planning agent won't revise it further. A maintainer will take it from here.`;
const FEEDBACK_NEEDED =
  "### Feedback needed\n\nTo get a revised plan, add a comment saying what to change, then apply `changes-requested` again.";

/**
 * Comments that steer the revision: by someone allowed to steer, posted before
 * the label was applied and not edited since, so the text is what the
 * maintainer saw when sending the plan back. Oldest first, at most a few.
 */
async function collectFeedback(
  since: Comment[],
  labelled: LabelEvent,
  maySteer: (account: GitHubAccount | null | undefined) => Promise<boolean>,
): Promise<string[]> {
  const feedback: string[] = [];
  for (const comment of since) {
    if (comment.createdAt > labelled.createdAt || comment.updatedAt > labelled.createdAt) continue;
    if (!(await maySteer(comment.user))) continue;
    const text = cleanFeedback(comment.body);
    if (text) feedback.push(text);
  }
  return feedback.slice(-MAX_FEEDBACK_COMMENTS);
}

interface Draft {
  revision: number;
  revisionInput?: PromptInput["revision"];
  /** Labels to drop before planning starts (a rejected plan is no longer ready). */
  removeOnStart?: string[];
  /** Labels to drop once the new plan is posted. */
  removeOnSuccess?: string[];
}

/** Ask the model for a plan, post it, and set the status labels. */
async function draftAndPost(
  issue: Issue,
  settings: PlannerSettings,
  deps: PlannerDeps,
  draft: Draft,
): Promise<PlannerOutcome> {
  const { github, log } = deps;
  const number = issue.number;
  let llm: LlmClient | null = null;
  let plan: Plan;
  let scope: ScopeCheck;
  let image = false;
  try {
    for (const label of draft.removeOnStart ?? []) await github.removeLabel(number, label);
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
      buildPlanMessages({
        description: request.description,
        slug,
        ...context,
        screenshotUrl,
        revision: draft.revisionInput,
      }),
    );
    scope = checkScope(plan, slug);
    if (scope.reasons.length > 0) {
      notes.unshift(
        `This plan needs a maintainer before it can go ahead: ${scope.reasons.join("; ")}.`,
      );
    }
    // A maintainer may have taken over while the model was working. (An
    // approval applied meanwhile is refused by the approval gate, because this
    // plan is newer than it; dropping the plan here would strand the request.)
    const current = await github.getIssue(number);
    if (current.labels.includes(LABELS.needsHumanTriage)) {
      await bestEffort(log, number, [() => github.removeLabel(number, LABELS.planning)]);
      log("info", "planner.skipped", { issue: number, reason: "superseded" });
      return "skipped";
    }
    await github.createComment(
      number,
      renderPlanComment({
        plan,
        revision: draft.revision,
        slug,
        requestHash: requestHash(request),
        notes,
        triage: scope.reasons.length > 0,
      }),
    );
  } catch (error) {
    return fail(number, error, deps, llm);
  }

  // The plan is public now: a label problem must not contradict it, so it only
  // fails the run (the workflow then marks the request for a maintainer).
  // Out-of-area plans go to a maintainer instead of waiting for approval.
  const triage = scope.reasons.length > 0;
  // The new status first, so the request never shows an earlier stage in between.
  const labelled = await bestEffort(log, number, [
    () => github.addLabels(number, [triage ? LABELS.needsHumanTriage : LABELS.planReady]),
    () => github.removeLabel(number, LABELS.planning),
    ...(draft.removeOnSuccess ?? []).map((label) => () => github.removeLabel(number, label)),
  ]);
  log(labelled ? "info" : "error", "planner.planned", {
    issue: number,
    revision: draft.revision,
    files: plan.files.length,
    tokens: llm.tokensUsed,
    image,
    flaggedInstructions: plan.instructionsInRequest,
    rejectedPaths: scope.rejectedPaths,
    needs: scope.needs.join(","),
    triage,
    labelled,
  });
  return labelled ? "planned" : "failed";
}

/** Log the failure, then hand the request to a maintainer with a fixed comment. */
async function fail(
  number: number,
  error: unknown,
  deps: PlannerDeps,
  llm: LlmClient | null,
): Promise<PlannerOutcome> {
  const { github, log } = deps;
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
