// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { buildMarker } from "../gate/gate.mts";
import type { Comment, GitHubClient } from "../lib/github.mts";
import { type ChatMessage, type LlmClient, LlmError } from "../lib/llm.mts";
import { type Plan, parsePlan, renderPlanComment } from "../planner/plan.mts";
import { AGENT_ID, AGENT_LOGIN } from "../planner/planner.mts";
import { RETRY_INSTRUCTION } from "../planner/prompt.mts";
import type { Git } from "../scope-check/pull-request.mts";
import { reviewMarker } from "./review.mts";
import {
  type ReviewSettings,
  builtPlan,
  readDemoFiles,
  renderReviewError,
  reviewPullRequest,
} from "./reviewer.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const HEAD = "c".repeat(40);
const agent = { login: AGENT_LOGIN, id: AGENT_ID, type: "Bot" };
const someone = { login: "someone", id: 9, type: "User" };

const comment = (id: number, body: string, user = agent, updatedAt?: string): Comment => ({
  id,
  body,
  user,
  createdAt: "2026-10-08T09:00:00Z",
  updatedAt: updatedAt ?? "2026-10-08T09:00:00Z",
});

const planBody = (title: string) =>
  renderPlanComment({
    plan: parsePlan(
      JSON.stringify({
        title,
        summary: "A counter.",
        steps: ["Create demo.tsx"],
        files: [{ path: `${dir}demo.tsx`, action: "create", purpose: "The demo" }],
        tests: [],
        concerns: [],
      }),
    ) as Plan,
    revision: 1,
    slug: SLUG,
    requestHash: "b".repeat(64),
    triage: false,
  });

describe("builtPlan", () => {
  it("takes the agent's last plan before its last build comment", () => {
    const comments = [
      comment(1, planBody("Old plan")),
      comment(2, buildMarker(50)),
      comment(3, planBody("Built plan")),
      comment(4, planBody("Fake plan"), someone),
      comment(5, buildMarker(60)),
      comment(6, planBody("Newer, unbuilt plan")),
    ];
    expect(builtPlan(comments)?.split("\n")[0]).toBe("Built plan");
  });

  it("needs a build comment and an unedited plan, both from the agent", () => {
    expect(builtPlan([comment(1, planBody("Plan"))])).toBeNull();
    expect(
      builtPlan([comment(1, planBody("Plan")), comment(2, buildMarker(5), someone)]),
    ).toBeNull();
    expect(
      builtPlan([
        comment(1, planBody("Plan"), agent, "2026-10-08T09:30:00Z"),
        comment(2, buildMarker(5)),
      ]),
    ).toBeNull();
  });
});

type Entry = { path: string; content?: string; mode?: string; type?: string; size?: number };

function fakeGit(entries: Entry[]) {
  const blobs = new Map<string, Uint8Array>();
  const listing = entries
    .map((entry, i) => {
      const blob = String(i + 1).padStart(40, "0");
      const bytes = new TextEncoder().encode(entry.content ?? "");
      blobs.set(blob, bytes);
      const size = String(entry.size ?? bytes.length).padStart(7);
      return `${entry.mode ?? "100644"} ${entry.type ?? "blob"} ${blob} ${size}\t${entry.path}\0`;
    })
    .join("");
  const git = {
    text: vi.fn<Git["text"]>(async () => listing),
    bytes: vi.fn<Git["bytes"]>(async (args) => blobs.get(args[2]) ?? new Uint8Array()),
  } satisfies Git;
  return git;
}

const demoFiles: Entry[] = [
  { path: `${dir}demo-loader.tsx`, content: "loader" },
  { path: `${dir}counter.ts`, content: "export const step = 1;\n" },
  { path: `${dir}demo.test.tsx`, content: "it('counts', () => {});\n" },
  { path: `${dir}demo.tsx`, content: '"use client";\nexport default function Demo() {}\n' },
  { path: `${dir}page.tsx`, content: "page" },
];

describe("readDemoFiles", () => {
  it("reads the demo's own files at the head, demo first, without the templates", async () => {
    const git = fakeGit(demoFiles);
    const read = await readDemoFiles(git, HEAD, SLUG);
    expect(git.text).toHaveBeenCalledWith([
      "ls-tree",
      "-r",
      "-l",
      "-z",
      "--full-tree",
      HEAD,
      "--",
      dir,
    ]);
    expect("files" in read && read.files.map((file) => file.path)).toEqual([
      `${dir}demo.tsx`,
      `${dir}counter.ts`,
      `${dir}demo.test.tsx`,
    ]);
    expect("files" in read && read.files[0].content).toBe(
      '"use client";\nexport default function Demo() {}\n',
    );
  });

  it("refuses anything the write-scope rules wouldn't allow", async () => {
    for (const entry of [
      { path: `${dir}notes.md`, content: "x" },
      { path: `${dir}helper.ts`, mode: "100755" },
      { path: `${dir}link.ts`, mode: "120000" },
      { path: `${dir}nested`, mode: "160000", type: "commit" },
      { path: `src/app/demos/request-70/demo.tsx` },
    ]) {
      const read = await readDemoFiles(fakeGit([...demoFiles, entry]), HEAD, SLUG);
      expect(read).toEqual({
        problem: "The demo folder holds files the write-scope rules don't allow.",
      });
    }
  });

  it("refuses a missing demo, oversized files and non-UTF-8 text", async () => {
    const without = demoFiles.filter((entry) => !entry.path.endsWith("/demo.tsx"));
    expect(await readDemoFiles(fakeGit(without), HEAD, SLUG)).toEqual({
      problem: "There's no demo.tsx.",
    });
    expect(
      await readDemoFiles(
        fakeGit([...demoFiles, { path: `${dir}big.ts`, size: 30_001 }]),
        HEAD,
        SLUG,
      ),
    ).toEqual({ problem: "They're too large for an automated review." });
    const many = Array.from({ length: 3 }, (_, i) => ({
      path: `${dir}part-${i}.ts`,
      size: 25_000,
    }));
    expect(await readDemoFiles(fakeGit([...demoFiles, ...many]), HEAD, SLUG)).toEqual({
      problem: "They're too large for an automated review.",
    });

    const git = fakeGit(demoFiles);
    git.bytes.mockResolvedValueOnce(new Uint8Array([0xff, 0xfe, 0x41]));
    expect(await readDemoFiles(git, HEAD, SLUG)).toEqual({
      problem: "Some of them aren't UTF-8 text.",
    });
  });

  it("refuses a listing it can't parse", async () => {
    const git = fakeGit([]);
    git.text.mockResolvedValueOnce("garbage\0");
    expect(await readDemoFiles(git, HEAD, SLUG)).toEqual({
      problem: "Git listed something unexpected.",
    });
  });

  it("leaves the templates out of the limits, and caps the number of files", async () => {
    const bigPage = demoFiles.map((entry) =>
      entry.path.endsWith("/page.tsx") ? { ...entry, size: 40_000 } : entry,
    );
    expect("files" in (await readDemoFiles(fakeGit(bigPage), HEAD, SLUG))).toBe(true);
    const helpers = Array.from({ length: 10 }, (_, i) => ({ path: `${dir}helper-${i}.ts` }));
    expect(await readDemoFiles(fakeGit([...demoFiles, ...helpers]), HEAD, SLUG)).toEqual({
      problem: "They're too large for an automated review.",
    });
  });

  it("refuses a submodule as git lists it", async () => {
    const git = fakeGit(demoFiles);
    git.text.mockResolvedValueOnce(`160000 commit ${"e".repeat(40)}       -\t${dir}vendor\0`);
    expect(await readDemoFiles(git, HEAD, SLUG)).toEqual({
      problem: "The demo folder holds files the write-scope rules don't allow.",
    });
  });
});

const settings: ReviewSettings = {
  pullNumber: 30,
  headSha: HEAD,
  pull: {
    headRef: SLUG,
    headRepo: "octo/requests",
    baseRepo: "octo/requests",
    baseRef: "main",
    author: "coding-agent[bot]",
    agentLogin: "coding-agent[bot]",
  },
};

function fakeGitHub(issueComments: Comment[], pullComments: Comment[] = []) {
  const posted: { number: number; body: string }[] = [];
  const github = {
    getIssue: vi.fn<GitHubClient["getIssue"]>(),
    listComments: vi.fn(async (number: number) => (number === 7 ? issueComments : pullComments)),
    createComment: vi.fn(async (number: number, body: string) => {
      posted.push({ number, body });
    }),
    addLabels: vi.fn<GitHubClient["addLabels"]>(),
    removeLabel: vi.fn<GitHubClient["removeLabel"]>(),
    getRole: vi.fn<GitHubClient["getRole"]>(),
    labelEvents: vi.fn<GitHubClient["labelEvents"]>(),
    latestLabelEvent: vi.fn<GitHubClient["latestLabelEvent"]>(),
  } satisfies GitHubClient;
  return { github, posted };
}

type Reply = string | Error | { text: string; finishReason: string };

function fakeLlm(...replies: Reply[]) {
  const calls: ChatMessage[][] = [];
  const client: LlmClient = {
    tokensUsed: 0,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      calls.push(messages);
      const next = replies.shift() ?? "";
      if (next instanceof Error) throw next;
      const { text, finishReason } =
        typeof next === "string" ? { text: next, finishReason: "stop" } : next;
      return { text, finishReason, tokens: 10, estimated: false };
    }),
  };
  return { client, calls };
}

const built = [comment(1, planBody("Counter demo")), comment(2, buildMarker(5))];
const PASS = '{"result":"pass","summary":"Matches the plan.","findings":[]}';

function run(
  options: {
    issueComments?: Comment[];
    pullComments?: Comment[];
    replies?: Reply[];
    files?: Entry[];
    settings?: ReviewSettings;
  } = {},
) {
  const { github, posted } = fakeGitHub(options.issueComments ?? built, options.pullComments);
  const llm = fakeLlm(...(options.replies ?? [PASS]));
  const log = vi.fn();
  const createLlm = vi.fn(() => llm.client);
  const outcome = reviewPullRequest(options.settings ?? settings, {
    github,
    git: fakeGit(options.files ?? demoFiles),
    log,
    createLlm,
    readAgentsGuide: async () => "Demo rules.",
  });
  return { outcome, posted, calls: llm.calls, createLlm, log };
}

describe("reviewPullRequest", () => {
  it("posts one review for the head commit", async () => {
    const { outcome, posted, calls } = run();
    expect(await outcome).toBe("reviewed");
    expect(posted).toHaveLength(1);
    expect(posted[0].number).toBe(30);
    expect(posted[0].body.startsWith(reviewMarker("pass", HEAD))).toBe(true);
    expect(posted[0].body).toContain("Matches the plan.");
    expect(calls).toHaveLength(1);
    expect(calls[0][1].content).toContain("Counter demo");
    expect(calls[0][1].content).toContain("export default function Demo() {}");
  });

  it("skips pull requests that aren't the agent's request pull requests", async () => {
    for (const pull of [
      { ...settings.pull, author: "someone" },
      { ...settings.pull, headRef: "feature/x" },
      { ...settings.pull, headRepo: "fork/requests" },
      { ...settings.pull, baseRef: "develop" },
      { ...settings.pull, agentLogin: "" },
    ]) {
      const { outcome, posted, createLlm } = run({ settings: { ...settings, pull } });
      expect(await outcome).toBe("skipped");
      expect(posted).toHaveLength(0);
      expect(createLlm).not.toHaveBeenCalled();
    }
    const { outcome, log } = run({ settings: { ...settings, headSha: "abc" } });
    expect(await outcome).toBe("skipped");
    expect(log).toHaveBeenCalledWith("info", "review.skipped", {
      pull: 30,
      reason: "invalid_head",
    });
  });

  it("reviews each commit once, but retries after an error", async () => {
    const reviewed = run({ pullComments: [comment(9, reviewMarker("findings", HEAD))] });
    expect(await reviewed.outcome).toBe("skipped");
    expect(reviewed.createLlm).not.toHaveBeenCalled();

    for (const pullComments of [
      [comment(9, reviewMarker("error", HEAD))],
      [comment(9, reviewMarker("pass", "d".repeat(40)))],
      [comment(9, reviewMarker("pass", HEAD), someone)],
      // Edited, or with the marker anywhere but the start: not the agent's review.
      [comment(9, reviewMarker("pass", HEAD), agent, "2026-10-08T09:30:00Z")],
      [comment(9, `Quoting: ${reviewMarker("pass", HEAD)}`)],
    ]) {
      const { outcome } = run({ pullComments });
      expect(await outcome).toBe("reviewed");
    }
  });

  it("says so when the built plan can't be found", async () => {
    const { outcome, posted, createLlm } = run({ issueComments: [comment(1, planBody("Plan"))] });
    expect(await outcome).toBe("error");
    expect(posted[0].body).toBe(renderReviewError("no_plan", HEAD));
    expect(createLlm).not.toHaveBeenCalled();
  });

  it("says so when the files can't be read", async () => {
    const { outcome, posted, createLlm } = run({ files: [{ path: `${dir}notes.md` }] });
    expect(await outcome).toBe("error");
    expect(posted[0].body).toBe(
      renderReviewError(
        "unreadable_files",
        HEAD,
        "The demo folder holds files the write-scope rules don't allow.",
      ),
    );
    expect(createLlm).not.toHaveBeenCalled();
  });

  it("asks once more for a usable reply, then gives up", async () => {
    const retried = run({ replies: ["not json", PASS] });
    expect(await retried.outcome).toBe("reviewed");
    expect(retried.calls[1].at(-1)).toEqual({ role: "user", content: RETRY_INSTRUCTION });

    const failed = run({ replies: ["not json", "still not json"] });
    expect(await failed.outcome).toBe("error");
    expect(failed.posted[0].body).toBe(renderReviewError("unusable_reply", HEAD));

    // A cut-off or filtered reply would be again: no retry.
    for (const finishReason of ["length", "content_filter"]) {
      const stopped = run({ replies: [{ text: PASS, finishReason }] });
      expect(await stopped.outcome).toBe("error");
      expect(stopped.calls).toHaveLength(1);
    }
  });

  it("shows the coding agent's file checks next to the model's verdict", async () => {
    const files = demoFiles.map((entry) =>
      entry.path.endsWith("/demo.tsx")
        ? {
            ...entry,
            content:
              '"use client";\nimport fs from "node:fs";\nexport default function Demo() {}\n',
          }
        : entry,
    );
    const { outcome, posted, log } = run({ files });
    expect(await outcome).toBe("reviewed");
    expect(posted[0].body.startsWith(reviewMarker("findings", HEAD))).toBe(true);
    expect(posted[0].body).toContain("**File checks:** 1 problem.");
    expect(posted[0].body).toContain("imports a module demos may not use");
    expect(log).toHaveBeenCalledWith("info", "review.posted", {
      pull: 30,
      result: "pass",
      findings: 0,
      checks: 1,
    });
  });

  it("reports a model that isn't configured", async () => {
    const { github, posted } = fakeGitHub(built);
    const outcome = await reviewPullRequest(settings, {
      github,
      git: fakeGit(demoFiles),
      log: vi.fn(),
      createLlm: () => {
        throw new LlmError("config", "LLM_MODEL missing");
      },
      readAgentsGuide: async () => "",
    });
    expect(outcome).toBe("error");
    expect(posted[0].body).toBe(renderReviewError("llm", HEAD));
  });

  it("reports model errors by kind only", async () => {
    const { outcome, posted, log } = run({
      replies: [new LlmError("cap_exceeded", "budget used")],
    });
    expect(await outcome).toBe("error");
    expect(posted[0].body).toBe(renderReviewError("llm", HEAD));
    expect(log).toHaveBeenCalledWith("warn", "review.llm_error", {
      pull: 30,
      kind: "cap_exceeded",
    });
  });

  it("lets GitHub errors through to the entry point", async () => {
    const { github } = fakeGitHub(built);
    github.listComments.mockRejectedValueOnce(new Error("boom"));
    await expect(
      reviewPullRequest(settings, {
        github,
        git: fakeGit(demoFiles),
        log: vi.fn(),
        createLlm: () => fakeLlm(PASS).client,
        readAgentsGuide: async () => "",
      }),
    ).rejects.toThrow("boom");
  });
});
