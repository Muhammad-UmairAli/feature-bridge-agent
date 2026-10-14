// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildRequestIssue } from "@/lib/github/issues";

import { buildMarker } from "../gate/gate.mts";
import { parseAllowlist } from "../lib/allowlist.mts";
import {
  type Comment,
  GitHubApiError,
  type GitHubClient,
  type LabelChange,
} from "../lib/github.mts";
import { type ChatMessage, type LlmClient, LlmError } from "../lib/llm.mts";
import { type Plan, extractPlanText, parsePlan, renderPlanComment } from "../planner/plan.mts";
import { AGENT_ID, AGENT_LOGIN } from "../planner/planner.mts";
import { requestHash } from "../planner/request.mts";
import {
  BUILD_CANCELLED_MARKER,
  BUILD_STOPPED_MARKER,
  type BuildSettings,
  MAX_BUNDLE_CHARS,
  PULL_OPENED_MARKER,
  decodeBundle,
  encodeBundle,
  runCheck,
  runGenerate,
  runPublish,
} from "./build.mts";
import { FILE_END } from "./files.mts";
import { PublishIncomplete, PublishRefused } from "./publish.mts";

const BOT = "request-portal[bot]";
const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const DESCRIPTION = "Add a counter.";
const agent = { login: AGENT_LOGIN, id: AGENT_ID, type: "Bot" };
const lead = { login: "Lead", id: 7, type: "User" };

const plan = parsePlan(
  JSON.stringify({
    title: "Counter demo",
    summary: "A counter with + and - buttons.",
    steps: ["Create demo.tsx", "Add a test"],
    files: [
      { path: `${dir}demo.tsx`, action: "create", purpose: "The demo" },
      { path: `${dir}demo.test.tsx`, action: "create", purpose: "Tests" },
    ],
    tests: ["Clicking + increments"],
    concerns: [],
  }),
) as Plan;
const planBody = renderPlanComment({
  plan,
  revision: 1,
  slug: SLUG,
  requestHash: requestHash({ description: DESCRIPTION, screenshotUrl: null }),
  triage: false,
});
const planText = extractPlanText(planBody) as string;
const planSha256 = createHash("sha256").update(planText).digest("hex");
const planComment: Comment = {
  id: 100,
  body: planBody,
  user: agent,
  createdAt: "2026-10-08T09:00:00Z",
  updatedAt: "2026-10-08T09:00:00Z",
};
const history: LabelChange[] = [
  { id: 1, event: "labeled", label: "planning", actor: agent, createdAt: "2026-10-08T08:59:00Z" },
  { id: 2, event: "labeled", label: "plan-ready", actor: agent, createdAt: "2026-10-08T09:00:00Z" },
  {
    id: 3,
    event: "labeled",
    label: "approved-by-human",
    actor: lead,
    createdAt: "2026-10-08T10:00:00Z",
  },
];

const settings: BuildSettings = {
  issueNumber: 7,
  portalBotLogin: BOT,
  allowlist: parseAllowlist("lead"),
  expected: { approvalEventId: 3, planCommentId: 100, planSha256 },
};

function fakeGitHub(labels = ["portal-request", "plan-ready", "approved-by-human"]) {
  const comments: Comment[] = [planComment];
  const events: string[] = [];
  const current = new Set(labels);
  const github = {
    getIssue: vi.fn(async () => ({
      number: 7,
      state: "open",
      body: buildRequestIssue({ description: DESCRIPTION, screenshotUrl: null }).body,
      user: { login: BOT, id: 1, type: "Bot" },
      labels: [...current],
      isPullRequest: false,
    })),
    listComments: vi.fn(async () => comments),
    createComment: vi.fn(async (_n: number, body: string) => {
      events.push(`comment:${body.split("\n")[0]}`);
      comments.push({
        id: 200 + comments.length,
        body,
        user: agent,
        createdAt: "2026-10-08T10:01:00Z",
        updatedAt: "2026-10-08T10:01:00Z",
      });
    }),
    addLabels: vi.fn(async (_n: number, names: string[]) => {
      for (const name of names) current.add(name);
      events.push(`+${names.join(",")}`);
    }),
    removeLabel: vi.fn(async (_n: number, name: string) => {
      current.delete(name);
      events.push(`-${name}`);
    }),
    getRole: vi.fn<(login: string) => Promise<string>>(async () => "write"),
    labelEvents: vi.fn<GitHubClient["labelEvents"]>(async () => history),
    latestLabelEvent: vi.fn<GitHubClient["latestLabelEvent"]>(async () => null),
  } satisfies GitHubClient;
  return { github, comments, events, current };
}

const reply = [
  `<<<FILE ${dir}demo.tsx>>>`,
  '"use client";\n\nexport default function Demo() {\n  return <p>Counter</p>;\n}',
  FILE_END,
  `<<<FILE ${dir}demo.test.tsx>>>`,
  'import { render, screen } from "@testing-library/react";\nimport { expect, it } from "vitest";\n\nimport Demo from "./demo";\n\nit("renders", () => {\n  render(<Demo />);\n  expect(screen.getByText("Counter")).toBeInTheDocument();\n});',
  FILE_END,
].join("\n");

function fakeLlm(answer: string | Error = reply) {
  const calls: ChatMessage[][] = [];
  const client: LlmClient = {
    tokensUsed: 321,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      calls.push(messages);
      if (answer instanceof Error) throw answer;
      return { text: answer, finishReason: "stop", tokens: 1, estimated: false };
    }),
  };
  return { client, calls };
}

const generateDeps = (gh: ReturnType<typeof fakeGitHub>, llm = fakeLlm()) => ({
  github: gh.github,
  log: vi.fn(),
  createLlm: () => llm.client,
  readContext: async () => ({ agentsGuide: "# Guide", context: [] }),
});

describe("bundles", () => {
  const bundle = {
    issueNumber: 7,
    slug: SLUG,
    approvalEventId: 3,
    planSha256,
    files: [{ path: `${dir}demo.tsx`, content: "x\n" }],
  };

  it("round-trip through gzip and base64 with a checksum", () => {
    const { bundle: text, sha256 } = encodeBundle(bundle);
    expect(text).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeBundle(text, sha256)).toEqual(bundle);
    const revised = { ...bundle, revision: { pullNumber: 30, head: "c".repeat(40) } };
    const encoded = encodeBundle(revised);
    expect(decodeBundle(encoded.bundle, encoded.sha256)).toEqual(revised);
  });

  it("refuse changed, foreign or malformed data", () => {
    const { bundle: text, sha256 } = encodeBundle(bundle);
    // One character changed in the middle (the tail can already be "AAAA").
    const tampered = `${text.slice(0, 10)}${text[10] === "B" ? "C" : "B"}${text.slice(11)}`;
    expect(decodeBundle(tampered, sha256)).toBeNull();
    expect(decodeBundle(text, "0".repeat(64))).toBeNull();
    expect(decodeBundle("not base64!", sha256)).toBeNull();
    const notGzip = Buffer.from("{}").toString("base64");
    expect(decodeBundle(notGzip, createHash("sha256").update(notGzip).digest("hex"))).toBeNull();
    const empty = encodeBundle({ ...bundle, files: [] });
    expect(decodeBundle(empty.bundle, empty.sha256)).toBeNull();
    const badHead = encodeBundle({ ...bundle, revision: { pullNumber: 30, head: "main" } });
    expect(decodeBundle(badHead.bundle, badHead.sha256)).toBeNull();
  });
});

describe("runGenerate", () => {
  it("records the build before calling the model, then returns a checked bundle", async () => {
    const gh = fakeGitHub();
    const llm = fakeLlm();
    const result = await runGenerate(settings, generateDeps(gh, llm));
    expect(result.kind).toBe("built");
    if (result.kind !== "built") return;
    expect(gh.comments.at(-1)?.body.startsWith(buildMarker(3))).toBe(true);
    expect(gh.github.createComment.mock.invocationCallOrder[0]).toBeLessThan(
      (llm.client.chat as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    const bundle = decodeBundle(result.bundle, result.sha256);
    expect(bundle?.files.map((file) => file.path)).toEqual([
      `${dir}page.tsx`,
      `${dir}demo-loader.tsx`,
      `${dir}demo.tsx`,
      `${dir}demo.test.tsx`,
    ]);
    // The model gets the approved plan as data, not the request text.
    expect(String(llm.calls[0][1].content)).toContain(planText);
    expect(String(llm.calls[0][1].content)).not.toContain(DESCRIPTION);
  });

  it("hands over when the approval no longer passes, rather than leaving it building", async () => {
    const gh = fakeGitHub([
      "portal-request",
      "plan-ready",
      "approved-by-human",
      "needs-human-triage",
    ]);
    const llm = fakeLlm();
    expect(await runGenerate(settings, generateDeps(gh, llm))).toEqual({ kind: "failed" });
    expect(gh.comments.at(-1)?.body.startsWith(BUILD_STOPPED_MARKER)).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("stops quietly when the approval was withdrawn", async () => {
    const gh = fakeGitHub(["portal-request", "plan-ready"]);
    expect(await runGenerate(settings, generateDeps(gh))).toEqual({ kind: "stopped" });
    expect(gh.events).toEqual([]);
  });

  it("propagates a failure to record the build, before any model call", async () => {
    const gh = fakeGitHub();
    gh.github.createComment.mockRejectedValueOnce(new GitHubApiError("issues.createComment", 502));
    const llm = fakeLlm();
    await expect(runGenerate(settings, generateDeps(gh, llm))).rejects.toBeInstanceOf(
      GitHubApiError,
    );
    expect(llm.calls).toHaveLength(0);
  });

  it("stops without touching anything when the approval isn't the expected one", async () => {
    for (const expected of [
      { ...settings.expected, approvalEventId: 99 },
      { ...settings.expected, planSha256: "f".repeat(64) },
    ]) {
      const gh = fakeGitHub();
      const llm = fakeLlm();
      expect(await runGenerate({ ...settings, expected }, generateDeps(gh, llm))).toEqual({
        kind: "stopped",
      });
      expect(gh.events).toEqual([]);
      expect(llm.calls).toHaveLength(0);
    }
  });

  it("builds an approval only once", async () => {
    const gh = fakeGitHub();
    await runGenerate(settings, generateDeps(gh));
    const llm = fakeLlm();
    expect(await runGenerate(settings, generateDeps(gh, llm))).toEqual({ kind: "stopped" });
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    [new LlmError("cap_exceeded", "x"), "reached its token budget"],
    [new LlmError("provider", "x"), "couldn't reach the model"],
  ])("hands over with fixed text when generation fails (%s)", async (error, text) => {
    const gh = fakeGitHub();
    expect(await runGenerate(settings, generateDeps(gh, fakeLlm(error)))).toEqual({
      kind: "failed",
    });
    const stopped = gh.comments.at(-1)?.body ?? "";
    expect(stopped.startsWith(BUILD_STOPPED_MARKER)).toBe(true);
    expect(stopped).toContain(text);
    expect(gh.current.has("escalated-to-human")).toBe(true);
  });

  it("hands over when the files never pass, without echoing them", async () => {
    const gh = fakeGitHub();
    const bad = `<<<FILE ${dir}demo.tsx>>>\nfetch("/x?secret=1");\n${FILE_END}`;
    expect(await runGenerate(settings, generateDeps(gh, fakeLlm(bad)))).toEqual({ kind: "failed" });
    const stopped = gh.comments.at(-1)?.body ?? "";
    expect(stopped).toContain("didn't pass the demo checks");
    expect(stopped).not.toContain("secret");
  });
});

describe("runCheck", () => {
  it("lints the bundle's files and reports problems", async () => {
    const { bundle, sha256 } = encodeBundle({
      issueNumber: 7,
      slug: SLUG,
      approvalEventId: 3,
      planSha256,
      files: [{ path: `${dir}demo.tsx`, content: "x\n" }],
    });
    const lint = vi.fn<(files: { path: string; content: string }[]) => Promise<string[]>>(
      async () => ["problem"],
    );
    expect(await runCheck(bundle, sha256, lint)).toEqual(["problem"]);
    expect(lint.mock.calls[0][0]).toEqual([{ path: `${dir}demo.tsx`, content: "x\n" }]);
    expect(await runCheck(bundle, "0".repeat(64), lint)).toEqual([
      "the generated files didn't arrive intact",
    ]);
  });
});

describe("bundle size", () => {
  it("keeps the largest allowed demo well under the limit for one environment variable", () => {
    // 64,000 bytes of hard-to-compress printable text in 300-character lines.
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    const line = () =>
      Array.from({ length: 299 }, () => String.fromCharCode(33 + (random() % 94))).join("");
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `${dir}data-${i}.ts`,
      content: Array.from({ length: 53 }, line).join("\n"),
    }));
    const { bundle } = encodeBundle({
      issueNumber: 7,
      slug: SLUG,
      approvalEventId: 3,
      planSha256,
      files,
    });
    expect(bundle.length).toBeLessThan(MAX_BUNDLE_CHARS);
  });
});

describe("runPublish", () => {
  async function generated() {
    const result = await runGenerate(settings, generateDeps(fakeGitHub()));
    if (result.kind !== "built") throw new Error("expected a bundle");
    return result;
  }

  function publishDeps(
    gh: ReturnType<typeof fakeGitHub>,
    publish = vi.fn(async () => ({
      branch: SLUG,
      commitSha: "d".repeat(40),
      pullNumber: 12,
      pullUrl: "https://github.test/pull/12",
    })),
  ) {
    return {
      github: gh.github,
      log: vi.fn(),
      token: vi.fn(async () => "fake-token"),
      revoke: vi.fn(async () => {}),
      publish,
    };
  }

  /** The issue as the publish job sees it: the build already recorded. */
  function builtIssue(labels?: string[]) {
    const gh = fakeGitHub(labels);
    gh.comments.push({
      ...planComment,
      id: 150,
      body: `${buildMarker(3)}\n### Building`,
      createdAt: "2026-10-08T10:01:00Z",
      updatedAt: "2026-10-08T10:01:00Z",
    });
    return gh;
  }

  it("publishes the bundle's files, reports the pull request and revokes the token", async () => {
    const { bundle, sha256 } = await generated();
    const gh = builtIssue();
    const deps = publishDeps(gh);
    expect(await runPublish(settings, deps, "octo/requests", bundle, sha256)).toEqual({
      kind: "published",
      pullNumber: 12,
    });
    const [token, input] = deps.publish.mock.calls[0] as unknown as [
      string,
      { files: { path: string }[] },
    ];
    expect(token).toBe("fake-token");
    expect(input.files).toHaveLength(4);
    expect(gh.comments.at(-1)?.body.startsWith(PULL_OPENED_MARKER)).toBe(true);
    expect(gh.comments.at(-1)?.body).toContain("#12");
    expect(deps.revoke).toHaveBeenCalledWith("fake-token");
  });

  it("refuses a bundle that changed on the way, before asking for a token", async () => {
    const { bundle } = await generated();
    const gh = builtIssue();
    const deps = publishDeps(gh);
    expect(await runPublish(settings, deps, "octo/requests", bundle, "0".repeat(64))).toEqual({
      kind: "failed",
    });
    expect(deps.token).not.toHaveBeenCalled();
    expect(gh.comments.at(-1)?.body).toContain("didn't arrive intact");
  });

  it("publishes nothing when the approval was withdrawn while building", async () => {
    const { bundle, sha256 } = await generated();
    const gh = builtIssue(["portal-request", "plan-ready"]);
    const deps = publishDeps(gh);
    expect(await runPublish(settings, deps, "octo/requests", bundle, sha256)).toEqual({
      kind: "stopped",
    });
    expect(deps.token).not.toHaveBeenCalled();
    expect(gh.comments.at(-1)?.body.startsWith(BUILD_CANCELLED_MARKER)).toBe(true);
    expect(gh.current.has("escalated-to-human")).toBe(false);
  });

  it.each([
    [new PublishRefused("branch_exists"), "A branch for this request already exists."],
    [new PublishIncomplete(SLUG), "couldn't be opened"],
    [new GitHubApiError("git.createCommit", 422), "couldn't be published"],
  ])("hands over and still revokes the token when publishing fails (%s)", async (error, text) => {
    const { bundle, sha256 } = await generated();
    const gh = builtIssue();
    const deps = publishDeps(
      gh,
      vi.fn(async () => {
        throw error;
      }),
    );
    expect(await runPublish(settings, deps, "octo/requests", bundle, sha256)).toEqual({
      kind: "failed",
    });
    expect(gh.comments.at(-1)?.body).toContain(text);
    expect(gh.current.has("escalated-to-human")).toBe(true);
    expect(deps.revoke).toHaveBeenCalledWith("fake-token");
  });

  it("hands over when no token can be had", async () => {
    const { bundle, sha256 } = await generated();
    const gh = builtIssue();
    const deps = publishDeps(gh);
    deps.token.mockRejectedValue(new Error("App not installed"));
    expect(await runPublish(settings, deps, "octo/requests", bundle, sha256)).toEqual({
      kind: "failed",
    });
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(gh.comments.at(-1)?.body).not.toContain("App not installed");
  });
});
