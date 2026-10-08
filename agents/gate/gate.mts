/**
 * The approval gate: decides whether `approved-by-human` on a request issue is
 * a genuine approval of the plan that was reviewed, before anything is built.
 *
 * Everything is checked from the issue's current state, never the triggering
 * payload (re-runs replay it):
 * - who last applied the label, from the append-only event history: on the
 *   allowlist, a user, with a live triage-or-higher role, not the issue author;
 * - the status labels, and the label history since the plan was posted (no
 *   new drafting, no hand-over, even if someone removed those labels again);
 * - the plan: the latest one the workflow bot posted, before the approval,
 *   never edited, marked ready when posted, made from the current request,
 *   not followed by a "planning stopped" comment, and still within the
 *   demo-area rules;
 * - and that this approval hasn't already been used for a build.
 * A refused approval loses its label and gets a fixed explanation.
 *
 * Known limit: every workflow in the repository comments as the same bot, so
 * anyone who can push a workflow (write access) could forge a plan comment.
 */
import { createHash } from "node:crypto";

import { type Allowlist, STEERING_ROLES, isAllowlisted } from "../lib/allowlist.mts";
import {
  type Comment,
  GitHubApiError,
  type GitHubClient,
  type LabelChange,
} from "../lib/github.mts";
import { PLAN_MARKER, STOPPED_MARKER, extractPlanText } from "../planner/plan.mts";
import { AGENT_ID, AGENT_LOGIN, type Log, agentPlanComments } from "../planner/planner.mts";
import {
  LABELS,
  demoSlug,
  isPortalIssue,
  parseRequestBody,
  requestHash,
} from "../planner/request.mts";
import { checkPlanText } from "../planner/scope.mts";

export const REFUSED_MARKER = "<!-- feature-bridge-agent:approval-refused -->";

/** Written by the build job before it starts, so one approval builds at most once. */
export const buildMarker = (approvalEventId: number) =>
  `<!-- feature-bridge-agent:build approval=${approvalEventId} -->`;

export interface GateSettings {
  issueNumber: number;
  portalBotLogin: string;
  allowlist: Allowlist;
}

export interface Approval {
  /** The `labeled` event this approval is; the key for "built at most once". */
  approvalEventId: number;
  planCommentId: number;
  /** The approved plan as posted (inside its fence). */
  planText: string;
  /** SHA-256 of `planText`, for the build job to re-verify. */
  planSha256: string;
  slug: string;
}

export type GateOutcome =
  | { kind: "approved"; approval: Approval }
  | { kind: "refused"; reason: RefusalReason; cleanedUp: boolean }
  | { kind: "skipped"; reason: string };

/** Why an approval was refused, in fixed words (nothing untrusted is echoed). */
const REFUSALS = {
  not_allowed:
    "Only maintainers on the approver list who have triage access (or higher) to this repository can approve a plan.",
  self_approval: "A request can't be approved by the account that opened it.",
  not_ready:
    "A plan can be approved only while it is ready (`plan-ready`) and nothing else is pending: no change request, no planning in progress and no hand-over.",
  no_plan: "There is no plan from the planning agent to approve.",
  plan_newer:
    "The plan changed around the time of the approval (a newer plan was posted or drafted). Review the latest plan, then apply `approved-by-human` again.",
  plan_edited: "The plan comment was edited after it was posted, so it can't be approved as is.",
  plan_not_ready:
    "This plan was handed to a maintainer when it was posted (see its note), so it can't be built automatically.",
  request_changed:
    "The request changed after this plan was made. Ask for a revised plan with `changes-requested`.",
  out_of_scope: "The plan doesn't fit the demo-area rules, so it can't be built automatically.",
} as const;

export type RefusalReason = keyof typeof REFUSALS;

export interface GateDeps {
  github: GitHubClient;
  log: Log;
}

const time = (iso: string) => Date.parse(iso);

export async function checkApproval(settings: GateSettings, deps: GateDeps): Promise<GateOutcome> {
  const { github, log } = deps;
  const number = settings.issueNumber;
  const skip = (reason: string): GateOutcome => {
    log("info", "gate.skipped", { issue: number, reason });
    return { kind: "skipped", reason };
  };
  const refuse = async (reason: RefusalReason, rules: string[] = []): Promise<GateOutcome> => {
    log("info", "gate.refused", {
      issue: number,
      reason,
      ...(rules.length ? { rules: rules.join("; ") } : {}),
    });
    let removed = true;
    try {
      await github.removeLabel(number, LABELS.approved);
    } catch (error) {
      removed = false;
      log("error", "gate.cleanup_failed", {
        issue: number,
        ...(error instanceof GitHubApiError ? { status: error.status } : {}),
      });
    }
    let commented = true;
    try {
      await github.createComment(
        number,
        `${REFUSED_MARKER}\n### Approval not accepted\n\n${REFUSALS[reason]} ${
          removed
            ? "The `approved-by-human` label was removed."
            : "Please remove the `approved-by-human` label."
        }`,
      );
    } catch (error) {
      commented = false;
      log("error", "gate.cleanup_failed", {
        issue: number,
        ...(error instanceof GitHubApiError ? { status: error.status } : {}),
      });
    }
    return { kind: "refused", reason, cleanedUp: removed && commented };
  };

  const issue = await github.getIssue(number);
  if (!isPortalIssue(issue, settings.portalBotLogin)) return skip("not_a_portal_request");
  if (!issue.labels.includes(LABELS.approved)) return skip("label_removed");

  const history = await github.labelEvents(number);
  const approvals = history.filter((c) => c.event === "labeled" && c.label === LABELS.approved);
  const approval = approvals[approvals.length - 1];
  if (!approval) return skip("label_removed");
  const later = (change: LabelChange) => change.id > approval.id;
  if (history.some((c) => c.label === LABELS.approved && c.event === "unlabeled" && later(c))) {
    return skip("label_removed"); // the history hasn't caught up; a newer run decides
  }

  const comments = await github.listComments(number);
  const marker = buildMarker(approval.id);
  if (comments.some((c) => byAgent(c) && c.body.startsWith(marker))) {
    return skip("already_built");
  }

  const actor = approval.actor;
  if (!actor || !isAllowlisted(settings.allowlist, actor)) return refuse("not_allowed");
  if (!STEERING_ROLES.has(await github.getRole(actor.login))) return refuse("not_allowed");
  if (issue.user && actor.id === issue.user.id) return refuse("self_approval");

  const has = (label: string) => issue.labels.includes(label);
  if (
    !has(LABELS.planReady) ||
    has(LABELS.changesRequested) ||
    has(LABELS.planning) ||
    has(LABELS.needsHumanTriage)
  ) {
    return refuse("not_ready");
  }

  const plans = agentPlanComments(comments);
  const plan = plans[plans.length - 1];
  if (!plan) return refuse("no_plan");
  const planned = time(plan.createdAt);
  const approvedAt = time(approval.createdAt);
  if (
    !Number.isFinite(planned) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(time(plan.updatedAt))
  ) {
    return refuse("plan_newer");
  }
  // Equal seconds count as "newer": the approver can't have seen it.
  if (planned >= approvedAt) return refuse("plan_newer");
  // A plan drafted (or handed over) after this one, even if its comment or the
  // labels were removed since, means this isn't the plan to build.
  // (Drafting starts before its plan is posted, so `planning` must be strictly
  // later; a hand-over can land in the same second as the plan it concerns.)
  const added = history.filter((c) => c.event === "labeled");
  if (added.some((c) => c.label === LABELS.planning && time(c.createdAt) > planned)) {
    return refuse("plan_newer");
  }
  if (added.some((c) => c.label === LABELS.needsHumanTriage && time(c.createdAt) >= planned)) {
    return refuse("not_ready");
  }
  if (plan.updatedAt !== plan.createdAt) return refuse("plan_edited");

  const fields = PLAN_MARKER.exec(plan.body);
  if (fields?.[3] !== "1") return refuse("plan_not_ready");
  const after = comments.slice(comments.indexOf(plan) + 1);
  if (after.some((c) => byAgent(c) && c.body.startsWith(STOPPED_MARKER))) {
    return refuse("plan_not_ready");
  }
  const request = parseRequestBody(issue.body);
  if (!request || !fields[2] || fields[2] !== requestHash(request)) {
    return refuse("request_changed");
  }

  const slug = demoSlug(number);
  const planText = extractPlanText(plan.body);
  if (planText === null) return refuse("out_of_scope");
  const rules = checkPlanText(planText, slug);
  if (rules.length > 0) return refuse("out_of_scope", rules);

  log("info", "gate.approved", { issue: number, planComment: plan.id, approvalEvent: approval.id });
  return {
    kind: "approved",
    approval: {
      approvalEventId: approval.id,
      planCommentId: plan.id,
      planText,
      planSha256: createHash("sha256").update(planText).digest("hex"),
      slug,
    },
  };
}

const byAgent = (comment: Comment) =>
  comment.user?.type === "Bot" &&
  comment.user.login === AGENT_LOGIN &&
  comment.user.id === AGENT_ID;
