// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildRequestIssue } from "@/lib/github/issues";

import { parseAllowlist } from "../lib/allowlist.mts";
import {
  type Comment,
  GitHubApiError,
  type GitHubClient,
  type Issue,
  type LabelChange,
} from "../lib/github.mts";
import {
  type Plan,
  STOPPED_MARKER,
  extractPlanText,
  parsePlan,
  renderPlanComment,
} from "../planner/plan.mts";
import { AGENT_ID, AGENT_LOGIN } from "../planner/planner.mts";
import { requestHash } from "../planner/request.mts";
import { REFUSED_MARKER, buildMarker, checkApproval } from "./gate.mts";

const BOT = "request-portal[bot]";
const DESCRIPTION = "Add a counter.";
const DRAFTED_AT = "2026-10-08T08:59:00Z";
const PLANNED_AT = "2026-10-08T09:00:00Z";
const APPROVED_AT = "2026-10-08T10:00:00Z";
const LATER = "2026-10-08T09:30:00Z";
const lead = { login: "Lead", id: 7, type: "User" };
const agent = { login: AGENT_LOGIN, id: AGENT_ID, type: "Bot" };
const HASH = requestHash({ description: DESCRIPTION, screenshotUrl: null });

const plan = parsePlan(
  JSON.stringify({
    title: "Counter demo",
    summary: "A counter with + and - buttons.",
    steps: ["Create page.tsx", "Add counter.tsx"],
    files: [
      { path: "src/app/demos/request-7/page.tsx", action: "create", purpose: "Route" },
      { path: "src/app/demos/request-7/counter.tsx", action: "create", purpose: "Component" },
      { path: "src/app/demos/request-7/counter.test.tsx", action: "create", purpose: "Tests" },
    ],
    tests: ["Clicking + increments"],
    concerns: [],
  }),
) as Plan;

const planBody = (overrides: Partial<Plan> = {}, hash = HASH, triage = false) =>
  renderPlanComment({
    plan: { ...plan, ...overrides },
    revision: 1,
    slug: "request-7",
    requestHash: hash,
    triage,
  });

const planComment = (body = planBody(), times: Partial<Comment> = {}): Comment => ({
  id: 100,
  body,
  user: agent,
  createdAt: PLANNED_AT,
  updatedAt: PLANNED_AT,
  ...times,
});

let nextEventId = 1;
const change = (
  event: "labeled" | "unlabeled",
  label: string,
  createdAt: string,
  actor: LabelChange["actor"] = agent,
): LabelChange => ({ id: (nextEventId += 1), event, label, actor, createdAt });

/** The usual history: drafted, plan posted and ready, then approved. */
const history = (approver: LabelChange["actor"] = lead, extra: LabelChange[] = []) => [
  change("labeled", "portal-request", "2026-10-08T08:58:00Z"),
  change("labeled", "planning", DRAFTED_AT),
  change("labeled", "plan-ready", PLANNED_AT),
  change("unlabeled", "planning", PLANNED_AT),
  ...extra,
  change("labeled", "approved-by-human", APPROVED_AT, approver),
];

function setup({
  labels = ["portal-request", "plan-ready", "approved-by-human"],
  comments = [planComment()],
  events = history(),
  role = "write",
  description = DESCRIPTION,
}: {
  labels?: string[];
  comments?: Comment[];
  events?: LabelChange[];
  role?: string;
  description?: string;
} = {}) {
  const issue: Issue = {
    number: 7,
    state: "open",
    body: buildRequestIssue({ description, screenshotUrl: null }).body,
    user: { login: BOT, id: 1, type: "Bot" },
    labels,
    isPullRequest: false,
  };
  const posted: string[] = [];
  const current = new Set(labels);
  const github = {
    getIssue: vi.fn(async () => issue),
    listComments: vi.fn(async () => comments),
    createComment: vi.fn(async (_n: number, body: string) => {
      posted.push(body);
    }),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async (_n: number, name: string) => {
      current.delete(name);
    }),
    getRole: vi.fn<(login: string) => Promise<string>>(async () => role),
    labelEvents: vi.fn<GitHubClient["labelEvents"]>(async () => events),
    latestLabelEvent: vi.fn<GitHubClient["latestLabelEvent"]>(async () => null),
  } satisfies GitHubClient;
  const log = vi.fn();
  return { github, log, posted, current, deps: { github, log } };
}

const settings = { issueNumber: 7, portalBotLogin: BOT, allowlist: parseAllowlist("lead") };

describe("checkApproval", () => {
  it("accepts a genuine approval of the latest, unedited, ready, in-scope plan", async () => {
    const events = history();
    const t = setup({ events });
    const outcome = await checkApproval(settings, t.deps);
    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    const planText = extractPlanText(planBody()) as string;
    expect(outcome.approval).toEqual({
      approvalEventId: events[events.length - 1].id,
      planCommentId: 100,
      planText,
      planSha256: createHash("sha256").update(planText).digest("hex"),
      slug: "request-7",
    });
    expect(t.posted).toEqual([]);
    expect(t.current.has("approved-by-human")).toBe(true);
    expect(t.github.getRole).toHaveBeenCalledWith("Lead");
  });

  it("skips issues that aren't portal requests, without touching them", async () => {
    const t = setup();
    const issue = await t.github.getIssue();
    t.github.getIssue.mockResolvedValue({
      ...issue,
      user: { login: "someone", id: 5, type: "User" },
    });
    expect(await checkApproval(settings, t.deps)).toEqual({
      kind: "skipped",
      reason: "not_a_portal_request",
    });
    expect(t.posted).toEqual([]);
    expect(t.current.has("approved-by-human")).toBe(true);
  });

  it("skips when the label was removed, never recorded, or removed after the latest approval", async () => {
    expect(
      (await checkApproval(settings, setup({ labels: ["portal-request", "plan-ready"] }).deps))
        .kind,
    ).toBe("skipped");
    expect((await checkApproval(settings, setup({ events: [] }).deps)).kind).toBe("skipped");
    const removedLater = setup({
      events: [...history(), change("unlabeled", "approved-by-human", APPROVED_AT, lead)],
    });
    expect(await checkApproval(settings, removedLater.deps)).toEqual({
      kind: "skipped",
      reason: "label_removed",
    });
    expect(removedLater.posted).toEqual([]);
  });

  it("skips an approval that was already used for a build", async () => {
    const events = history();
    const approvalId = events[events.length - 1].id;
    const built: Comment = {
      ...planComment(`${buildMarker(approvalId)}\nBuilding`),
      id: 300,
      createdAt: "2026-10-08T10:01:00Z",
      updatedAt: "2026-10-08T10:01:00Z",
    };
    const t = setup({ events, comments: [planComment(), built] });
    expect(await checkApproval(settings, t.deps)).toEqual({
      kind: "skipped",
      reason: "already_built",
    });
    expect(t.posted).toEqual([]);
  });

  it.each([
    [
      "an account not on the list",
      { events: history({ login: "stranger", id: 9, type: "User" }) },
      "not_allowed",
    ],
    ["a bot", { events: history({ login: "lead", id: 7, type: "Bot" }) }, "not_allowed"],
    ["a deleted account", { events: history(null) }, "not_allowed"],
    ["a listed account without triage access", { role: "read" }, "not_allowed"],
    ["a custom role", { role: "reviewer" }, "not_allowed"],
    [
      "the issue author",
      { events: history({ login: "lead", id: 1, type: "User" }) },
      "self_approval",
    ],
    ["a plan that isn't ready", { labels: ["portal-request", "approved-by-human"] }, "not_ready"],
    [
      "a pending change request",
      { labels: ["portal-request", "plan-ready", "changes-requested", "approved-by-human"] },
      "not_ready",
    ],
    [
      "a plan being drafted",
      { labels: ["portal-request", "plan-ready", "planning", "approved-by-human"] },
      "not_ready",
    ],
    [
      "a request handed to a maintainer",
      { labels: ["portal-request", "plan-ready", "needs-human-triage", "approved-by-human"] },
      "not_ready",
    ],
    [
      "a hand-over whose label was removed by hand",
      {
        events: history(lead, [
          change("labeled", "needs-human-triage", LATER),
          change("unlabeled", "needs-human-triage", LATER),
        ]),
      },
      "not_ready",
    ],
    ["no plan", { comments: [] }, "no_plan"],
    [
      "a plan posted after the approval",
      {
        comments: [
          planComment(undefined, {
            createdAt: "2026-10-08T11:00:00Z",
            updatedAt: "2026-10-08T11:00:00Z",
          }),
        ],
      },
      "plan_newer",
    ],
    [
      "a plan posted in the same second as the approval",
      { comments: [planComment(undefined, { createdAt: APPROVED_AT, updatedAt: APPROVED_AT })] },
      "plan_newer",
    ],
    [
      "a newer draft whose plan comment was deleted",
      { events: history(lead, [change("labeled", "planning", LATER)]) },
      "plan_newer",
    ],
    [
      "missing timestamps",
      { comments: [planComment(undefined, { createdAt: "", updatedAt: "" })] },
      "plan_newer",
    ],
    ["an edited plan", { comments: [planComment(undefined, { updatedAt: LATER })] }, "plan_edited"],
    [
      "a plan that was handed over when posted",
      { comments: [planComment(planBody({}, HASH, true))] },
      "plan_not_ready",
    ],
    [
      "a plan followed by a planning-stopped comment",
      {
        comments: [
          planComment(),
          {
            ...planComment(`${STOPPED_MARKER}\n### Planning stopped`),
            id: 101,
            createdAt: LATER,
            updatedAt: LATER,
          },
        ],
      },
      "plan_not_ready",
    ],
    ["a request edited after planning", { description: "Add a timer instead." }, "request_changed"],
    [
      "a plan without a fingerprint",
      { comments: [planComment(planBody({}, ""))] },
      "request_changed",
    ],
    [
      "an out-of-scope plan",
      {
        comments: [
          planComment(
            planBody({
              files: [...plan.files, { path: "package.json", action: "modify", purpose: "" }],
            }),
          ),
        ],
      },
      "out_of_scope",
    ],
    [
      "a plan whose text points elsewhere",
      { comments: [planComment(planBody({ steps: ["Run pnpm add lodash"] }))] },
      "out_of_scope",
    ],
  ])("refuses %s, removing the label with a fixed comment", async (_name, options, reason) => {
    const t = setup(options as Parameters<typeof setup>[0]);
    expect(await checkApproval(settings, t.deps)).toEqual({
      kind: "refused",
      reason,
      cleanedUp: true,
    });
    expect(t.current.has("approved-by-human")).toBe(false);
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0].startsWith(REFUSED_MARKER)).toBe(true);
    expect(t.posted[0]).toContain("The `approved-by-human` label was removed.");
    expect(t.posted[0]).not.toContain("stranger");
  });

  it("binds only to plans posted by the workflow bot itself", async () => {
    const forged = { ...planComment(), id: 200, user: { login: AGENT_LOGIN, id: 1, type: "Bot" } };
    const t = setup({ comments: [planComment(), forged] });
    const outcome = await checkApproval(settings, t.deps);
    expect(outcome.kind === "approved" && outcome.approval.planCommentId).toBe(100);
  });

  it("logs which scope rules refused a plan, without plan text", async () => {
    const t = setup({ comments: [planComment(planBody({ steps: ["Run pnpm add lodash"] }))] });
    await checkApproval(settings, t.deps);
    expect(t.log).toHaveBeenCalledWith("info", "gate.refused", {
      issue: 7,
      reason: "out_of_scope",
      rules: "the plan mentions installing or changing dependencies",
    });
  });

  it("reports an incomplete refusal and words the comment accordingly", async () => {
    const t = setup({ role: "read" });
    t.github.removeLabel.mockRejectedValue(new GitHubApiError("issues.removeLabel", 500));
    expect(await checkApproval(settings, t.deps)).toEqual({
      kind: "refused",
      reason: "not_allowed",
      cleanedUp: false,
    });
    expect(t.log).toHaveBeenCalledWith("error", "gate.cleanup_failed", { issue: 7, status: 500 });
    expect(t.posted[0]).toContain("Please remove the `approved-by-human` label.");

    const noComment = setup({ role: "read" });
    noComment.github.createComment.mockRejectedValue(
      new GitHubApiError("issues.createComment", 502),
    );
    expect(await checkApproval(settings, noComment.deps)).toMatchObject({ cleanedUp: false });
  });

  it("lets GitHub errors surface, so the workflow's fallback removes the label", async () => {
    const roles = setup();
    roles.github.getRole.mockRejectedValue(
      new GitHubApiError("repos.getCollaboratorPermission", 403),
    );
    await expect(checkApproval(settings, roles.deps)).rejects.toBeInstanceOf(GitHubApiError);
    const comments = setup();
    comments.github.listComments.mockRejectedValue(new Error("too many comments to read safely"));
    await expect(checkApproval(settings, comments.deps)).rejects.toThrow("too many comments");
  });
});
