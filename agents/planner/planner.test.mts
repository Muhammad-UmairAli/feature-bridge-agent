// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { buildRequestIssue } from "@/lib/github/issues";

import { type Comment, GitHubApiError, type GitHubClient, type Issue } from "../lib/github.mts";
import { type ChatMessage, type ChatOptions, type LlmClient, LlmError } from "../lib/llm.mts";
import { PLAN_MARKER, STOPPED_MARKER, planMarker } from "./plan.mts";
import { parseAllowlist } from "../lib/allowlist.mts";
import {
  AGENT_ID,
  AGENT_LOGIN,
  type PlannerDeps,
  agentPlanComments,
  planRequest,
} from "./planner.mts";
import { RETRY_INSTRUCTION } from "./prompt.mts";

const BOT = "request-portal[bot]";
const SCREENSHOT =
  "https://abc123.public.blob.vercel-storage.com/screenshots/0b5f1a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b.png";

const planReply = JSON.stringify({
  title: "Counter demo",
  summary: "A counter.",
  steps: ["Create the page"],
  files: [{ path: "src/app/demos/request-7/page.tsx", action: "create", purpose: "Route" }],
  tests: ["Renders"],
  concerns: [],
  instructionsInRequest: false,
});

function portalIssue(overrides: Partial<Issue> = {}, screenshotUrl: string | null = null): Issue {
  return {
    number: 7,
    state: "open",
    body: buildRequestIssue({ description: "Add a counter.", screenshotUrl }).body,
    user: { login: BOT, id: 1, type: "Bot" },
    labels: ["portal-request"],
    isPullRequest: false,
    ...overrides,
  };
}

function fakeGitHub(issue: Issue, comments: Comment[] = []) {
  const posted: string[] = [];
  const events: string[] = [];
  const labels = new Set(issue.labels);
  const github = {
    getIssue: vi.fn(async () => issue),
    listComments: vi.fn(async () => comments),
    createComment: vi.fn(async (_n: number, body: string) => {
      posted.push(body);
      events.push("comment");
    }),
    addLabels: vi.fn(async (_n: number, names: string[]) => {
      for (const name of names) labels.add(name);
      events.push(`+${names.join(",")}`);
    }),
    removeLabel: vi.fn(async (_n: number, name: string) => {
      labels.delete(name);
      events.push(`-${name}`);
    }),
    getRole: vi.fn<(login: string) => Promise<string>>(async () => "write"),
    latestLabelEvent: vi.fn<GitHubClient["latestLabelEvent"]>(async () => ({
      actor: { login: "Lead", id: 7, type: "User" },
      createdAt: "2026-10-08T10:00:00Z",
    })),
  } satisfies GitHubClient;
  return { github, posted, events, labels };
}

type Reply = string | Error | { text: string; finishReason: string };

function fakeLlm(...replies: Reply[]) {
  const calls: { messages: ChatMessage[]; options: ChatOptions }[] = [];
  const client: LlmClient = {
    tokensUsed: 1234,
    chat: vi.fn(async (messages: ChatMessage[], options: ChatOptions) => {
      calls.push({ messages, options });
      const next = replies.shift();
      if (next === undefined) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      const { text, finishReason } =
        typeof next === "string" ? { text: next, finishReason: "stop" } : next;
      return { text, finishReason, tokens: 100, estimated: false };
    }),
  };
  return { client, calls };
}

function setup(
  issue: Issue,
  llmReplies: Reply[] = [planReply],
  overrides: Partial<PlannerDeps> = {},
  comments: Comment[] = [],
) {
  const gh = fakeGitHub(issue, comments);
  const llm = fakeLlm(...llmReplies);
  const log = vi.fn();
  const deps: PlannerDeps = {
    github: gh.github,
    createLlm: () => llm.client,
    readContext: async () => ({ agentsGuide: "# Guide", repoFiles: ["src/app/page.tsx"] }),
    checkScreenshot: vi.fn(async () => "available" as const),
    log,
    ...overrides,
  };
  return { ...gh, llm, log, deps };
}

const settings = { issueNumber: 7, portalBotLogin: BOT, imageInput: false };
const agentComment = (body: string, user = { login: AGENT_LOGIN, id: 41898282, type: "Bot" }) => ({
  id: 1,
  body,
  user,
  createdAt: "",
  updatedAt: "",
});

describe("agentPlanComments", () => {
  it("counts only the workflow bot's comments that start with the plan marker", () => {
    const comments: Comment[] = [
      agentComment(`${planMarker(1)}\nplan`),
      agentComment(`no marker\n${planMarker(1)}`),
      agentComment("plain comment"),
      agentComment(`${planMarker(2)}`, { login: "someone", id: 5, type: "User" }),
      agentComment(`${planMarker(2)}`, { login: AGENT_LOGIN, id: 5, type: "User" }),
    ];
    expect(agentPlanComments(comments)).toHaveLength(1);
  });
});

describe("planRequest", () => {
  it("posts a plan before swapping the planning label for plan-ready", async () => {
    const t = setup(portalIssue());
    expect(await planRequest(settings, t.deps)).toBe("planned");
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]).toMatch(PLAN_MARKER);
    expect(t.posted[0]).toContain("Counter demo");
    expect(t.events).toEqual(["+planning", "comment", "+plan-ready", "-planning"]);
    expect([...t.labels]).toEqual(["portal-request", "plan-ready"]);
    // The request reaches the model only as delimited data.
    expect(String(t.llm.calls[0].messages[1].content)).toMatch(
      /<<<REQUEST-[0-9a-f]+>>>\nAdd a counter\.\n<<<END-REQUEST-/,
    );
    // Provider-default temperature and a bounded call time.
    expect(t.llm.calls[0].options).toEqual({ maxOutputTokens: 4000, timeoutMs: 120_000 });
    expect(t.log).toHaveBeenCalledWith(
      "info",
      "planner.planned",
      expect.objectContaining({ tokens: 1234 }),
    );
  });

  it.each([
    [
      "not from the portal",
      { user: { login: "someone", id: 9, type: "User" } },
      "not_a_portal_request",
    ],
    [
      "already handed to a human",
      { labels: ["portal-request", "needs-human-triage"] },
      "already_decided",
    ],
    ["already approved", { labels: ["portal-request", "approved-by-human"] }, "already_decided"],
  ])("skips an issue that is %s, without touching it", async (_name, overrides, reason) => {
    const t = setup(portalIssue(overrides as Partial<Issue>));
    expect(await planRequest(settings, t.deps)).toBe("skipped");
    expect(t.events).toEqual([]);
    expect(t.log).toHaveBeenCalledWith("info", "planner.skipped", { issue: 7, reason });
  });

  it("skips when the agent already posted a plan, but not because of a look-alike from someone else", async () => {
    const plan = agentComment(`${planMarker(1)}\nplan`);
    const done = setup(portalIssue(), [], {}, [plan]);
    expect(await planRequest(settings, done.deps)).toBe("skipped");
    expect(done.events).toEqual([]);
    const forged = agentComment(`${planMarker(1)}\nplan`, {
      login: "someone",
      id: 5,
      type: "User",
    });
    expect(await planRequest(settings, setup(portalIssue(), [planReply], {}, [forged]).deps)).toBe(
      "planned",
    );
  });

  it("asks once more, without echoing the unusable reply, when the first isn't a plan", async () => {
    const t = setup(portalIssue(), ["Sure! Here is my plan: step 1...", planReply]);
    expect(await planRequest(settings, t.deps)).toBe("planned");
    expect(t.llm.calls).toHaveLength(2);
    const retry = t.llm.calls[1].messages;
    expect(retry.at(-1)).toEqual({ role: "user", content: RETRY_INSTRUCTION });
    expect(retry.some((m) => m.role === "assistant")).toBe(false);
  });

  it("stops without retrying when the reply was cut off", async () => {
    const t = setup(portalIssue(), [{ text: '{"title": "x"', finishReason: "length" }]);
    expect(await planRequest(settings, t.deps)).toBe("failed");
    expect(t.llm.calls).toHaveLength(1);
    expect(t.posted[0]).toContain("The model's plan was too long.");
  });

  it("hands over to a maintainer when the model never returns a plan", async () => {
    const t = setup(portalIssue(), ["nope", "still nope"]);
    expect(await planRequest(settings, t.deps)).toBe("failed");
    expect(t.posted[0].startsWith(STOPPED_MARKER)).toBe(true);
    expect(t.posted[0]).toContain("The model didn't return a usable plan.");
    expect([...t.labels]).toEqual(["portal-request", "needs-human-triage"]);
  });

  it.each([
    [new LlmError("cap_exceeded", "x"), "reached its token budget", "cap_exceeded"],
    [
      new LlmError("config", "Missing configuration: LLM_API_KEY"),
      "isn't configured correctly",
      "config",
    ],
    [new LlmError("rate_limited", "x"), "couldn't reach the model", "llm_rate_limited"],
    [new GitHubApiError("issues.get", 502), "couldn't update this issue", "github"],
    [new Error("boom"), "unexpected error", "unexpected"],
  ])("stops with a fixed comment and needs-human-triage on %s", async (error, text, reason) => {
    const t = setup(portalIssue(), [error]);
    expect(await planRequest(settings, t.deps)).toBe("failed");
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]).toContain(text);
    expect(t.posted[0]).not.toContain("LLM_API_KEY");
    expect([...t.labels]).toEqual(["portal-request", "needs-human-triage"]);
    expect(t.log).toHaveBeenCalledWith(
      "error",
      "planner.failed",
      expect.objectContaining({ reason }),
    );
  });

  it("hands over when GitHub fails before planning starts", async () => {
    const comments = setup(portalIssue());
    comments.github.listComments.mockRejectedValue(new GitHubApiError("issues.listComments", 502));
    expect(await planRequest(settings, comments.deps)).toBe("failed");
    expect(comments.labels.has("needs-human-triage")).toBe(true);

    const label = setup(portalIssue());
    label.github.addLabels.mockRejectedValueOnce(new GitHubApiError("issues.addLabels", 503));
    expect(await planRequest(settings, label.deps)).toBe("failed");
    expect(label.labels.has("needs-human-triage")).toBe(true);
    expect(label.log).toHaveBeenCalledWith(
      "error",
      "planner.failed",
      expect.objectContaining({ reason: "github", status: 503, name: "GitHubApiError" }),
    );
  });

  it("doesn't contradict a posted plan when only the label update fails", async () => {
    const t = setup(portalIssue());
    t.github.removeLabel.mockRejectedValueOnce(new GitHubApiError("issues.removeLabel", 500));
    expect(await planRequest(settings, t.deps)).toBe("failed");
    expect(t.posted).toHaveLength(1);
    expect(t.labels.has("needs-human-triage")).toBe(false);
    // The second label step still ran.
    expect(t.labels.has("plan-ready")).toBe(true);
    expect(t.log).toHaveBeenCalledWith(
      "error",
      "planner.planned",
      expect.objectContaining({ labelled: false }),
    );
  });

  it("posts an out-of-area plan with a note and hands it to a maintainer", async () => {
    const outOfArea = JSON.stringify({
      ...JSON.parse(planReply),
      files: [
        { path: "src/app/demos/request-7/page.tsx", action: "create" },
        { path: "package.json", action: "modify" },
      ],
      needs: { newDependency: true },
    });
    const t = setup(portalIssue(), [outOfArea]);
    expect(await planRequest(settings, t.deps)).toBe("planned");
    expect(t.posted[0]).toContain(
      "> **Note:** This plan needs a maintainer before it can go ahead: 1 planned file is outside `src/app/demos/request-7/` or not allowed there (see Files); it needs a new dependency.",
    );
    expect([...t.labels]).toEqual(["portal-request", "needs-human-triage"]);
    expect(t.log).toHaveBeenCalledWith(
      "info",
      "planner.planned",
      expect.objectContaining({ triage: true, rejectedPaths: 1, needs: "newDependency" }),
    );
  });

  it("hands a plan to a maintainer when the request tried to instruct the agent", async () => {
    const flagged = JSON.stringify({ ...JSON.parse(planReply), instructionsInRequest: true });
    const t = setup(portalIssue(), [flagged]);
    expect(await planRequest(settings, t.deps)).toBe("planned");
    expect(t.posted[0]).toContain("instructions aimed at the agent");
    expect(t.labels.has("needs-human-triage")).toBe(true);
    expect(t.labels.has("plan-ready")).toBe(false);
  });

  it("records a fingerprint of the request text in the plan marker", async () => {
    const t = setup(portalIssue());
    await planRequest(settings, t.deps);
    expect(t.posted[0]).toMatch(
      /^<!-- feature-bridge-agent:plan revision=1 request=[0-9a-f]{16} -->/,
    );
  });

  it("fails cleanly when the LLM settings are missing", async () => {
    const t = setup(portalIssue(), [], {
      createLlm: () => {
        throw new LlmError("config", "Missing configuration: LLM_API_KEY");
      },
    });
    expect(await planRequest(settings, t.deps)).toBe("failed");
    expect(t.labels.has("needs-human-triage")).toBe(true);
  });

  it("hands over when the request body can't be read or is too long", async () => {
    const unreadable = setup(portalIssue({ body: "edited by hand" }));
    expect(await planRequest(settings, unreadable.deps)).toBe("failed");
    expect(unreadable.posted[0]).toContain("The request text couldn't be read.");
    expect(unreadable.llm.calls).toHaveLength(0);

    const long = setup(portalIssue({ body: `\`\`\`text\n${"x".repeat(5001)}\n\`\`\`` }));
    expect(await planRequest(settings, long.deps)).toBe("failed");
    expect(long.posted[0]).toContain("longer than allowed");
    expect(long.llm.calls).toHaveLength(0);
  });

  it("still applies the triage label when commenting fails", async () => {
    const t = setup(portalIssue(), [new LlmError("provider", "x")]);
    t.github.createComment.mockRejectedValue(new Error("down"));
    expect(await planRequest(settings, t.deps)).toBe("failed");
    expect(t.labels.has("needs-human-triage")).toBe(true);
    expect(t.log).toHaveBeenCalledWith("error", "planner.cleanup_failed", { issue: 7 });
  });

  describe("screenshots", () => {
    it("are sent only when image input is on and the file still exists", async () => {
      const t = setup(portalIssue({}, SCREENSHOT));
      await planRequest({ ...settings, imageInput: true }, t.deps);
      expect(t.llm.calls[0].messages[1].content).toContainEqual({
        type: "image_url",
        image_url: { url: SCREENSHOT },
      });
    });

    it("are left out, with a note, when image input is off", async () => {
      const t = setup(portalIssue({}, SCREENSHOT));
      await planRequest(settings, t.deps);
      expect(typeof t.llm.calls[0].messages[1].content).toBe("string");
      expect(t.deps.checkScreenshot).not.toHaveBeenCalled();
      expect(t.posted[0]).toContain("Screenshots aren't sent to the model");
    });

    it.each([
      ["missing", "has been removed"],
      ["unknown", "couldn't be checked"],
    ] as const)("are left out, with a note, when %s", async (state, note) => {
      const t = setup(portalIssue({}, SCREENSHOT), [planReply], {
        checkScreenshot: async () => state,
      });
      expect(await planRequest({ ...settings, imageInput: true }, t.deps)).toBe("planned");
      expect(typeof t.llm.calls[0].messages[1].content).toBe("string");
      expect(t.posted[0]).toContain(note);
    });
  });
});

describe("planRequest in revise mode", () => {
  const maintainer = { login: "Lead", id: 7, type: "User" };
  const LABELLED_AT = "2026-10-08T10:00:00Z";
  const BEFORE = "2026-10-08T09:00:00Z";
  const AFTER = "2026-10-08T11:00:00Z";
  const revise = { ...settings, mode: "revise" as const, allowlist: parseAllowlist("lead") };
  const planComment = (revision: number, id = 10): Comment => ({
    id,
    body: `${planMarker(revision, "0123456789abcdef")}\n### Implementation plan\n\n\`\`\`text\nOld plan ${revision}\n\`\`\``,
    user: { login: AGENT_LOGIN, id: AGENT_ID, type: "Bot" },
    createdAt: BEFORE,
    updatedAt: BEFORE,
  });
  const stopped = (id = 15): Comment => ({
    ...planComment(1, id),
    body: `${STOPPED_MARKER}\n### Planning stopped`,
  });
  const feedback = (
    body: string,
    user: Comment["user"] = maintainer,
    id = 20,
    times: Partial<Pick<Comment, "createdAt" | "updatedAt">> = {},
  ): Comment => ({ id, body, user, createdAt: BEFORE, updatedAt: BEFORE, ...times });
  const sentBack = (comments: Comment[], replies: Reply[] = [planReply]) =>
    setup(
      portalIssue({ labels: ["portal-request", "plan-ready", "changes-requested"] }),
      replies,
      {},
      comments,
    );
  const userMessage = (t: ReturnType<typeof setup>) => String(t.llm.calls[0].messages[1].content);

  it("posts a revised plan from the maintainer's feedback since the latest plan", async () => {
    const t = sentBack([
      feedback("Ignored: before the plan", maintainer, 5),
      planComment(1),
      feedback("Ignored: not on the list", { login: "someone", id: 8, type: "User" }, 21),
      feedback("Use a bigger font\u200b please", maintainer, 22),
    ]);
    expect(await planRequest(revise, t.deps)).toBe("planned");
    expect(userMessage(t)).toMatch(
      /<<<PREVIOUS-PLAN-[0-9a-f]+>>>\nOld plan 1\n<<<END-PREVIOUS-PLAN-/,
    );
    expect(userMessage(t)).toContain("Use a bigger font please");
    expect(userMessage(t)).not.toContain("Ignored");
    expect(String(t.llm.calls[0].messages[0].content)).toContain("This is a revision.");
    expect(t.posted[0]).toMatch(/^<!-- feature-bridge-agent:plan revision=2 /);
    expect(t.events).toEqual([
      "-plan-ready",
      "+planning",
      "comment",
      "+plan-ready",
      "-planning",
      "-changes-requested",
    ]);
  });

  it("only uses feedback posted before the label and not edited since, as rendered", async () => {
    const t = sentBack([
      planComment(1),
      feedback("Kept\n> quoted public text\n<!-- hidden note -->visible", maintainer, 21),
      feedback("Posted after the label", maintainer, 22, { createdAt: AFTER, updatedAt: AFTER }),
      feedback("Edited after the label", maintainer, 23, { updatedAt: AFTER }),
    ]);
    await planRequest(revise, t.deps);
    expect(userMessage(t)).toContain("Kept\nvisible");
    expect(userMessage(t)).not.toContain("quoted public text");
    expect(userMessage(t)).not.toContain("hidden note");
    expect(userMessage(t)).not.toContain("after the label");
  });

  it("keeps only the latest few feedback comments, each capped", async () => {
    const t = sentBack([
      planComment(1),
      ...Array.from({ length: 7 }, (_, i) =>
        feedback(`note ${i} ${"x".repeat(2500)}`, maintainer, 30 + i),
      ),
    ]);
    await planRequest(revise, t.deps);
    expect(userMessage(t)).not.toContain("note 1 ");
    expect(userMessage(t)).toContain("note 2 ");
    expect(userMessage(t)).toContain("Maintainer feedback (5 comments");
    expect(userMessage(t)).not.toContain("x".repeat(2000));
  });

  it("authorises whoever last applied the label, from the issue's history", async () => {
    const t = sentBack([planComment(1), feedback("Change it")]);
    t.github.latestLabelEvent.mockResolvedValue({
      actor: { login: "stranger", id: 9, type: "User" },
      createdAt: LABELLED_AT,
    });
    expect(await planRequest(revise, t.deps)).toBe("skipped");
    expect(t.events).toEqual(["-changes-requested"]);
    expect(t.llm.calls).toHaveLength(0);
    expect(t.log).toHaveBeenCalledWith("info", "planner.skipped", {
      issue: 7,
      reason: "sender_not_allowed",
    });
  });

  it.each([
    ["is a bot", { login: "lead", id: 7, type: "Bot" }],
    ["was deleted", null],
  ])("refuses a label applied by an account that %s", async (_name, actor) => {
    const t = sentBack([planComment(1), feedback("Change it")]);
    t.github.latestLabelEvent.mockResolvedValue({ actor, createdAt: LABELLED_AT });
    expect(await planRequest(revise, t.deps)).toBe("skipped");
  });

  it("refuses everyone when there is no allowlist", async () => {
    const t = sentBack([planComment(1), feedback("Change it")]);
    expect(await planRequest({ ...revise, allowlist: undefined }, t.deps)).toBe("skipped");
    expect(t.llm.calls).toHaveLength(0);
  });

  it("refuses a sender who no longer has triage access, looking their role up once", async () => {
    const t = sentBack([planComment(1), feedback("Change it")]);
    t.github.getRole.mockResolvedValue("read");
    expect(await planRequest(revise, t.deps)).toBe("skipped");
    expect(t.log).toHaveBeenCalledWith("info", "planner.skipped", {
      issue: 7,
      reason: "sender_without_access",
    });
    expect(t.github.getRole).toHaveBeenCalledTimes(1);
  });

  it("ignores feedback from allowlisted accounts that lost access", async () => {
    const t = sentBack([
      planComment(1),
      feedback("From the lead"),
      feedback("From a former lead", { login: "old", id: 9, type: "User" }, 23),
      feedback("From a deleted account", null, 24),
    ]);
    t.github.getRole.mockImplementation(async (login: string) => (login === "old" ? "" : "admin"));
    await planRequest({ ...revise, allowlist: parseAllowlist("lead old") }, t.deps);
    expect(userMessage(t)).toContain("From the lead");
    expect(userMessage(t)).not.toContain("former lead");
    expect(userMessage(t)).not.toContain("deleted account");
    // The sender also commented: one lookup per login.
    expect(t.github.getRole.mock.calls.map(([login]) => login)).toEqual(["lead", "old"]);
  });

  it("skips when the label was removed, never applied, or there is no plan yet", async () => {
    const removed = setup(portalIssue({ labels: ["portal-request", "plan-ready"] }));
    expect(await planRequest(revise, removed.deps)).toBe("skipped");
    const never = sentBack([planComment(1)]);
    never.github.latestLabelEvent.mockResolvedValue(null);
    expect(await planRequest(revise, never.deps)).toBe("skipped");
    const none = sentBack([feedback("Change it")]);
    expect(await planRequest(revise, none.deps)).toBe("skipped");
    expect(none.log).toHaveBeenCalledWith("info", "planner.skipped", {
      issue: 7,
      reason: "nothing_to_revise",
    });
  });

  it("skips a request that was already approved or handed over", async () => {
    const t = setup(
      portalIssue({ labels: ["portal-request", "changes-requested", "approved-by-human"] }),
    );
    expect(await planRequest(revise, t.deps)).toBe("skipped");
    expect(t.events).toEqual([]);
  });

  it("asks for feedback, and lets the label be applied again, when there is none", async () => {
    const t = sentBack([planComment(1)]);
    expect(await planRequest(revise, t.deps)).toBe("waiting");
    expect(t.posted[0]).toContain("add a comment saying what to change");
    expect([...t.labels]).toEqual(["portal-request", "plan-ready"]);
    expect(t.llm.calls).toHaveLength(0);
  });

  it("hands the request to a maintainer the second time a plan is sent back", async () => {
    const t = sentBack([
      planComment(1),
      feedback("Change it"),
      planComment(2, 30),
      feedback("Still no", maintainer, 31),
    ]);
    expect(await planRequest(revise, t.deps)).toBe("handed_over");
    expect(t.posted[0].startsWith(STOPPED_MARKER)).toBe(true);
    expect(t.posted[0]).toContain("sent back again");
    expect(t.labels.has("needs-human-triage")).toBe(true);
    expect(t.labels.has("plan-ready")).toBe(false);
    expect(t.llm.calls).toHaveLength(0);
  });

  it("counts a failed revision as a round", async () => {
    const t = sentBack([
      planComment(1),
      feedback("Change it"),
      stopped(25),
      feedback("Again", maintainer, 26),
    ]);
    expect(await planRequest(revise, t.deps)).toBe("handed_over");
    expect(t.llm.calls).toHaveLength(0);
  });

  it("returns failed when handing over or asking for feedback can't be completed", async () => {
    const twice = sentBack([planComment(1), planComment(2, 30)]);
    twice.github.addLabels.mockRejectedValueOnce(new GitHubApiError("issues.addLabels", 500));
    expect(await planRequest(revise, twice.deps)).toBe("failed");
    const ask = sentBack([planComment(1)]);
    ask.github.createComment.mockRejectedValueOnce(new GitHubApiError("issues.createComment", 500));
    expect(await planRequest(revise, ask.deps)).toBe("failed");
  });

  it("only counts plans posted by the workflow bot itself", async () => {
    const forged = { ...planComment(2, 30), user: { login: AGENT_LOGIN, id: 1, type: "Bot" } };
    const t = sentBack([planComment(1), forged, feedback("Change it", maintainer, 31)]);
    expect(await planRequest(revise, t.deps)).toBe("planned");
  });

  it("sends an out-of-area revision to a maintainer", async () => {
    const outOfArea = JSON.stringify({
      ...JSON.parse(planReply),
      files: [{ path: "package.json", action: "modify" }],
    });
    const t = sentBack([planComment(1), feedback("Add a chart library")], [outOfArea]);
    expect(await planRequest(revise, t.deps)).toBe("planned");
    expect([...t.labels]).toEqual(["portal-request", "needs-human-triage"]);
  });

  it("doesn't post a revision nobody saw once the request was approved meanwhile", async () => {
    const t = sentBack([planComment(1), feedback("Change it")]);
    const approved = { ...portalIssue(), labels: ["portal-request", "approved-by-human"] };
    t.github.getIssue
      .mockResolvedValueOnce(
        portalIssue({ labels: ["portal-request", "plan-ready", "changes-requested"] }),
      )
      .mockResolvedValueOnce(approved);
    expect(await planRequest(revise, t.deps)).toBe("skipped");
    expect(t.posted).toEqual([]);
    expect(t.log).toHaveBeenCalledWith("info", "planner.skipped", {
      issue: 7,
      reason: "superseded",
    });
  });

  it("hands over with a fixed comment when revising fails, or the role lookup does", async () => {
    const t = sentBack(
      [planComment(1), feedback("Change it")],
      [new LlmError("cap_exceeded", "x")],
    );
    expect(await planRequest(revise, t.deps)).toBe("failed");
    expect(t.posted[0]).toContain("reached its token budget");
    expect(t.labels.has("needs-human-triage")).toBe(true);
    expect(t.labels.has("planning")).toBe(false);

    const role = sentBack([planComment(1), feedback("Change it")]);
    role.github.getRole.mockRejectedValue(
      new GitHubApiError("repos.getCollaboratorPermission", 403),
    );
    expect(await planRequest(revise, role.deps)).toBe("failed");
    expect(role.labels.has("needs-human-triage")).toBe(true);
  });

  it("reports acceptance only after the sender is authorised", async () => {
    const accept = vi.fn();
    const allowed = sentBack([planComment(1), feedback("Change it")]);
    await planRequest(revise, { ...allowed.deps, accept });
    expect(accept).toHaveBeenCalledTimes(1);

    const refused = sentBack([planComment(1)]);
    refused.github.getRole.mockResolvedValue("");
    const notAccepted = vi.fn();
    await planRequest(revise, { ...refused.deps, accept: notAccepted });
    expect(notAccepted).not.toHaveBeenCalled();
  });
});
