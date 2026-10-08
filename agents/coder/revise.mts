/**
 * Revising a coding agent pull request when a maintainer applies
 * `changes-requested` to it. Like the build, it runs in jobs that never share
 * secrets, and each one checks the change request again from the pull
 * request's current state:
 *
 * - gate (no secrets): whoever last applied the label may steer the agents
 *   (approver list, a user, triage access or more). The first change request
 *   is revised; a later one, or one on a pull request already handed over
 *   (`escalated-to-human`, e.g. after two failed CI runs), goes to a
 *   maintainer (FR-16). Without feedback, the agent asks for it.
 * - generate (model key): record the round on the pull request before any
 *   model call, then rewrite the demo from the approved plan, its current files
 *   (read as git objects at the reviewed commit) and the feedback.
 * - check (no secrets): the build's lint job.
 * - publish (agent App key): one commit on top of exactly the reviewed commit.
 *
 * Feedback is what maintainers who may steer wrote on the pull request before
 * the label was applied: review summaries, inline review comments and
 * comments (edited ones excluded; review summaries have no edit time), with
 * hidden HTML and quoted lines removed. Comments the workflow posts are fixed
 * text; failures hand the pull request to a maintainer.
 */
import { createHash } from "node:crypto";

import {
  type Allowlist,
  type GitHubAccount,
  STEERING_ROLES,
  isAllowlisted,
} from "../lib/allowlist.mts";
import { GitHubApiError, type GitHubClient, type PullClient } from "../lib/github.mts";
import type { LlmClient } from "../lib/llm.mts";
import { clean } from "../planner/plan.mts";
import { type Log, byAgent, cleanFeedback } from "../planner/planner.mts";
import { LABELS } from "../planner/request.mts";
import { builtPlan, readDemoFiles } from "../reviewer/reviewer.mts";
import { classify, isSha } from "../scope-check/check.mts";
import type { Git } from "../scope-check/pull-request.mts";
import { MAX_BUNDLE_CHARS, decodeBundle, encodeBundle, generationText } from "./build.mts";
import type { GeneratedFile } from "./files.mts";
import { GenerationFailure, generateDemo } from "./generate.mts";
import { PublishRefused, type RevisionInput } from "./publish.mts";

export const REVISION_MARKER = /^<!-- feature-bridge-agent:revision request=(\d+) -->/;
export const revisionMarker = (labelEventId: number) =>
  `<!-- feature-bridge-agent:revision request=${labelEventId} -->`;
export const REVISION_STOPPED_MARKER = "<!-- feature-bridge-agent:revision-stopped -->";
export const REVISION_PUSHED_MARKER = "<!-- feature-bridge-agent:revision-pushed -->";

/**
 * Change requests the agent revises before the next one goes to a maintainer.
 * (Feedback is read from the whole pull request, so raising this would need a
 * window starting at the previous revision, as the planner does.)
 */
const MAX_REVISIONS = 1;
const MAX_FEEDBACK_ITEMS = 10;

export type ReviseClient = GitHubClient & PullClient;

export interface ReviseSettings {
  pullNumber: number;
  /** owner/name */
  repo: string;
  /** The coding agent's bot login (repository variable). */
  agentLogin: string;
  allowlist: Allowlist;
}

/** What the gate accepted; later jobs re-check the pull request against it. */
export interface ExpectedChange {
  labelEventId: number;
  headSha: string;
}

export interface ChangeRequest extends ExpectedChange {
  pullNumber: number;
  issueNumber: number;
  slug: string;
  planText: string;
  planSha256: string;
  /** Empty when checked with `allowUsed` (the feedback was already used). */
  feedback: string[];
}

export type Reason =
  | "not_agent_pull"
  | "label_removed"
  | "superseded"
  | "already_used"
  | "head_moved"
  | "not_allowed"
  | "escalated"
  | "limit"
  | "not_recorded"
  | "no_plan"
  | "no_feedback";

export type Verified = { ok: true; change: ChangeRequest } | { ok: false; reason: Reason };

/**
 * Check a change request against the pull request's current state, without
 * side effects. `expected` pins the label event and reviewed commit the gate
 * accepted; `allowUsed` accepts a change request whose round is already
 * recorded (the publish job).
 */
export async function verifyChangeRequest(
  settings: ReviseSettings,
  github: ReviseClient,
  options: { expected?: ExpectedChange; allowUsed?: boolean } = {},
): Promise<Verified> {
  const no = (reason: Reason): Verified => ({ ok: false, reason });
  const number = settings.pullNumber;
  const pull = await github.getPull(number);
  const kind = classify({
    headRef: pull.headRef,
    headRepo: pull.headRepo,
    baseRepo: settings.repo,
    baseRef: pull.baseRef,
    author: pull.user?.login ?? "",
    agentLogin: settings.agentLogin,
  });
  if (kind.kind !== "request" || pull.state !== "open" || pull.user?.type !== "Bot") {
    return no("not_agent_pull");
  }
  if (!isSha(pull.headSha)) return no("not_agent_pull");

  const labels = (await github.getIssue(number)).labels;
  if (!labels.includes(LABELS.changesRequested)) return no("label_removed");
  const history = await github.labelEvents(number);
  const labelled = history
    .filter((c) => c.event === "labeled" && c.label === LABELS.changesRequested)
    .at(-1);
  if (!labelled) return no("label_removed");
  const removedSince = history.some(
    (c) => c.event === "unlabeled" && c.label === LABELS.changesRequested && c.id > labelled.id,
  );
  if (removedSince) return no("label_removed");
  if (options.expected) {
    if (labelled.id !== options.expected.labelEventId) return no("superseded");
    if (pull.headSha !== options.expected.headSha) return no("head_moved");
  }

  const roles = new Map<string, boolean>();
  /** Allowlisted, a User, and still holding triage access (usernames can be re-registered). */
  const maySteer = async (account: GitHubAccount | null | undefined) => {
    if (!isAllowlisted(settings.allowlist, account)) return false;
    const login = String(account?.login).toLowerCase();
    if (!roles.has(login)) roles.set(login, STEERING_ROLES.has(await github.getRole(login)));
    return roles.get(login) === true;
  };
  if (!(await maySteer(labelled.actor))) return no("not_allowed");
  if (labels.includes(LABELS.escalatedToHuman)) return no("escalated");

  const comments = await github.listComments(number);
  const rounds = comments
    .filter(byAgent)
    .map((comment) => REVISION_MARKER.exec(comment.body)?.[1])
    .filter((id): id is string => id !== undefined);
  const used = rounds.includes(String(labelled.id));
  if (used && !options.allowUsed) return no("already_used");
  // Publishing needs the round on record, or it wouldn't count.
  if (!used && options.allowUsed) return no("not_recorded");
  if (rounds.length - (used ? 1 : 0) >= MAX_REVISIONS) return no("limit");

  const issueNumber = Number(pull.headRef.slice("request-".length));
  const planText = builtPlan(await github.listComments(issueNumber));
  if (planText === null) return no("no_plan");

  let feedback: string[] = [];
  if (!options.allowUsed) {
    const before = labelled.createdAt;
    const items: { at: string; text: string }[] = [];
    const add = async (
      user: GitHubAccount | null,
      at: string,
      edited: string,
      prefix: string,
      body: string,
    ) => {
      if (!at || at > before || edited > before || !(await maySteer(user))) return;
      const text = cleanFeedback(body);
      if (text) items.push({ at, text: `${prefix}${text}` });
    };
    for (const review of await github.listReviews(number)) {
      await add(review.user, review.submittedAt, review.submittedAt, "Review: ", review.body);
    }
    for (const comment of await github.listReviewComments(number)) {
      const where = `${clean(comment.path, 200)}${comment.line ? ` line ${comment.line}` : ""}`;
      await add(comment.user, comment.createdAt, comment.updatedAt, `On ${where}: `, comment.body);
    }
    for (const comment of comments) {
      await add(comment.user, comment.createdAt, comment.updatedAt, "Comment: ", comment.body);
    }
    feedback = items
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .slice(-MAX_FEEDBACK_ITEMS)
      .map((item) => item.text);
    if (feedback.length === 0) return no("no_feedback");
  }

  return {
    ok: true,
    change: {
      pullNumber: number,
      issueNumber,
      slug: kind.slug,
      headSha: pull.headSha,
      labelEventId: labelled.id,
      planText,
      planSha256: createHash("sha256").update(planText).digest("hex"),
      feedback,
    },
  };
}

const LIMIT = `${REVISION_STOPPED_MARKER}\n### Changes requested again\n\nThe coding agent has already had its one revision round on this pull request (including any that failed or was cancelled), so it won't revise it again. A maintainer will take it from here.`;
const ESCALATED =
  "### Not revised\n\nThis pull request is with a maintainer (`escalated-to-human`), so the coding agent won't change it.";
const FEEDBACK_NEEDED =
  "### Feedback needed\n\nTo get a revision, review the pull request (inline comments, a review summary or a comment) saying what to change, then apply `changes-requested` again.";
const NO_PLAN = "The approved plan couldn't be found unchanged on the request issue.";
const NOT_CURRENT =
  "The change request no longer passes the checks (for example its label or the pull request changed), so nothing was revised.";

/** Run each step even if an earlier one fails; true if all succeeded. */
async function bestEffort(log: Log, pull: number, steps: (() => Promise<void>)[]) {
  let ok = true;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      ok = false;
      log("error", "revise.update_failed", {
        pull,
        ...(error instanceof GitHubApiError ? { status: error.status } : {}),
      });
    }
  }
  return ok;
}

/** Fixed hand-over on the pull request: a comment and `escalated-to-human`. */
async function handOver(github: ReviseClient, log: Log, pull: number, text: string) {
  await bestEffort(log, pull, [
    () =>
      github.createComment(
        pull,
        `${REVISION_STOPPED_MARKER}\n### Revision stopped\n\n${text} A maintainer will take it from here.`,
      ),
    () => github.addLabels(pull, [LABELS.escalatedToHuman]),
  ]);
}

export interface ReviseDeps {
  github: ReviseClient;
  log: Log;
}

export type GateResult = { kind: "accepted"; expected: ExpectedChange } | { kind: "done" };

/** The gate job: accept the change request, or answer it on the pull request. */
export async function runReviseGate(
  settings: ReviseSettings,
  deps: ReviseDeps,
): Promise<GateResult> {
  const { github, log } = deps;
  const number = settings.pullNumber;
  const verified = await verifyChangeRequest(settings, github);
  if (verified.ok) {
    const { labelEventId, headSha } = verified.change;
    log("info", "revise.accepted", { pull: number, labelEvent: labelEventId });
    return { kind: "accepted", expected: { labelEventId, headSha } };
  }
  const { reason } = verified;
  log("info", "revise.not_accepted", { pull: number, reason });
  const removeLabel = () => github.removeLabel(number, LABELS.changesRequested);
  switch (reason) {
    // An unauthorised label would block the next real one (adding a present label fires nothing).
    case "not_allowed":
      await bestEffort(log, number, [removeLabel]);
      break;
    case "escalated":
      await bestEffort(log, number, [() => github.createComment(number, ESCALATED), removeLabel]);
      break;
    case "no_feedback":
      await bestEffort(log, number, [
        () => github.createComment(number, FEEDBACK_NEEDED),
        removeLabel,
      ]);
      break;
    case "limit":
      await bestEffort(log, number, [
        () => github.createComment(number, LIMIT),
        () => github.addLabels(number, [LABELS.escalatedToHuman]),
        removeLabel,
      ]);
      break;
    case "no_plan":
      await handOver(github, log, number, NO_PLAN);
      break;
    default:
      break; // nothing to do, or a newer run takes over
  }
  return { kind: "done" };
}

export interface ReviseGenerateDeps extends ReviseDeps {
  git: Git;
  createLlm: () => LlmClient;
  readContext: () => Promise<{ agentsGuide: string; context: GeneratedFile[] }>;
}

export type ReviseGenerateResult =
  { kind: "built"; bundle: string; sha256: string } | { kind: "stopped" } | { kind: "failed" };

/** Stops with nothing to say: nothing to do, a newer run takes over, or a maintainer has it. */
const QUIET: ReadonlySet<Reason | "mismatch"> = new Set<Reason>([
  "not_agent_pull",
  "label_removed",
  "superseded",
  "already_used",
  "escalated",
]);

/** The generate job: record the round, then rewrite the demo. */
export async function runReviseGenerate(
  settings: ReviseSettings,
  expected: ExpectedChange,
  deps: ReviseGenerateDeps,
): Promise<ReviseGenerateResult> {
  const { github, log } = deps;
  const number = settings.pullNumber;
  const verified = await verifyChangeRequest(settings, github, { expected });
  if (!verified.ok) {
    log("info", "revise.stopped", { pull: number, reason: verified.reason });
    if (QUIET.has(verified.reason)) return { kind: "stopped" };
    await handOver(github, log, number, NOT_CURRENT);
    return { kind: "failed" };
  }
  const { change } = verified;
  // Recorded before any model call: the round counts even if the revision fails.
  await github.createComment(
    number,
    `${revisionMarker(change.labelEventId)}\n### Revising\n\nThe coding agent is revising the demo from the review feedback.`,
  );

  let llm: LlmClient | null = null;
  try {
    const current = await readDemoFiles(deps.git, change.headSha, change.slug);
    if ("problem" in current) {
      throw new GenerationFailure("invalid_files", ["the current files couldn't be read"]);
    }
    const { agentsGuide, context } = await deps.readContext();
    llm = deps.createLlm();
    const files = await generateDemo(llm, {
      slug: change.slug,
      planText: change.planText,
      agentsGuide,
      context,
      revision: { files: current.files, feedback: change.feedback },
    });
    const { bundle, sha256 } = encodeBundle({
      issueNumber: change.issueNumber,
      slug: change.slug,
      approvalEventId: change.labelEventId,
      planSha256: change.planSha256,
      files,
      revision: { pullNumber: number, head: change.headSha },
    });
    if (bundle.length > MAX_BUNDLE_CHARS) {
      throw new GenerationFailure("invalid_files", ["the files are too large to hand on"]);
    }
    log("info", "revise.generated", { pull: number, files: files.length, tokens: llm.tokensUsed });
    return { kind: "built", bundle, sha256 };
  } catch (error) {
    const { reason, text } = generationText(error);
    log("error", "revise.failed", {
      pull: number,
      reason,
      ...(llm ? { tokens: llm.tokensUsed } : {}),
    });
    await handOver(github, log, number, text);
    return { kind: "failed" };
  }
}

export interface RevisePublishDeps extends ReviseDeps {
  /** An agent App installation token (contents and pull requests write). */
  token: () => Promise<string>;
  revoke: (token: string) => Promise<void>;
  push: (token: string, input: RevisionInput) => Promise<string>;
}

export type RevisePublishResult = { kind: "pushed" } | { kind: "stopped" } | { kind: "failed" };

const PUSH_TEXTS: Record<PublishRefused["reason"], string> = {
  branch_exists: "The demo couldn't be updated.",
  pull_exists: "The demo couldn't be updated.",
  folder_exists: "The demo couldn't be updated.",
  invalid_files: "The revised files didn't pass the final checks.",
  branch_moved: "The branch changed while the revision was being prepared, so nothing was pushed.",
  no_changes: "The revision didn't change any files, so nothing was pushed.",
};

/** The publish job: push the revision on top of the reviewed commit. */
export async function runRevisePublish(
  settings: ReviseSettings,
  expected: ExpectedChange,
  deps: RevisePublishDeps,
  bundleText: string,
  sha256: string,
): Promise<RevisePublishResult> {
  const { github, log } = deps;
  const number = settings.pullNumber;
  const bundle = decodeBundle(bundleText, sha256);
  if (
    !bundle?.revision ||
    bundle.revision.pullNumber !== number ||
    bundle.revision.head !== expected.headSha ||
    bundle.approvalEventId !== expected.labelEventId
  ) {
    log("error", "revise.failed", { pull: number, reason: "bad_bundle" });
    await handOver(github, log, number, "The revised files didn't arrive intact.");
    return { kind: "failed" };
  }
  // The change request may have been withdrawn or the branch changed while the model worked.
  const verified = await verifyChangeRequest(settings, github, { expected, allowUsed: true });
  if (
    !verified.ok ||
    verified.change.slug !== bundle.slug ||
    verified.change.issueNumber !== bundle.issueNumber ||
    verified.change.planSha256 !== bundle.planSha256
  ) {
    const reason = verified.ok ? "mismatch" : verified.reason;
    log("info", "revise.stopped", { pull: number, reason });
    if (reason === "label_removed" || reason === "superseded") {
      await bestEffort(log, number, [
        () =>
          github.createComment(
            number,
            `${REVISION_STOPPED_MARKER}\n### Revision cancelled\n\nThe change request was withdrawn or replaced while the demo was being revised, so nothing was pushed.`,
          ),
      ]);
      return { kind: "stopped" };
    }
    if (QUIET.has(reason)) return { kind: "stopped" };
    await handOver(github, log, number, NOT_CURRENT);
    return { kind: "failed" };
  }

  let token: string | null = null;
  try {
    token = await deps.token();
    await deps.push(token, {
      repo: settings.repo,
      issueNumber: bundle.issueNumber,
      slug: bundle.slug,
      files: bundle.files,
      head: expected.headSha,
    });
    log("info", "revise.pushed", { pull: number });
    await bestEffort(log, number, [
      () =>
        github.createComment(
          number,
          `${REVISION_PUSHED_MARKER}\n### Revision pushed\n\nThe coding agent pushed a revised demo. CI, the write-scope check and the automated review run again, and a maintainer reviews it before anything is merged.`,
        ),
      () => github.removeLabel(number, LABELS.changesRequested),
    ]);
    return { kind: "pushed" };
  } catch (error) {
    const reason = error instanceof PublishRefused ? error.reason : "unexpected";
    log("error", "revise.failed", {
      pull: number,
      reason,
      ...(error instanceof GitHubApiError ? { status: error.status } : {}),
    });
    await handOver(
      github,
      log,
      number,
      error instanceof PublishRefused
        ? PUSH_TEXTS[error.reason]
        : "The revision couldn't be pushed.",
    );
    return { kind: "failed" };
  } finally {
    if (token)
      await deps.revoke(token).catch(() => log("error", "revise.revoke_failed", { pull: number }));
  }
}
