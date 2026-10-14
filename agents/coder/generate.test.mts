// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { type ChatMessage, type ChatOptions, type LlmClient, LlmError } from "../lib/llm.mts";
import { CANNOT_BUILD, FILE_END } from "./files.mts";
import { GenerationFailure, buildMessages, generateDemo } from "./generate.mts";
import { loaderTemplate, pageTemplate } from "./template.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const input = {
  slug: SLUG,
  planText: "Counter demo\n\nFiles\n- src/app/demos/request-7/demo.tsx (create)",
  agentsGuide: "# AGENTS.md\nOnly the demo folder.",
  context: [{ path: "src/components/ui/button.tsx", content: "export function Button() {}\n" }],
};

const block = (path: string, content: string) =>
  [`<<<FILE ${dir}${path}>>>`, content, FILE_END].join("\n");
const demo = '"use client";\n\nexport default function Demo() {\n  return <p>Counter</p>;\n}';
const test =
  'import { render, screen } from "@testing-library/react";\nimport { expect, it } from "vitest";\n\nimport Demo from "./demo";\n\nit("renders", () => {\n  render(<Demo />);\n  expect(screen.getByText("Counter")).toBeInTheDocument();\n});';
const goodReply = [block("demo.tsx", demo), block("demo.test.tsx", test)].join("\n");

type Reply = { text: string; finishReason?: string } | Error;

function fakeLlm(...replies: Reply[]) {
  const calls: { messages: ChatMessage[]; options: ChatOptions }[] = [];
  const client: LlmClient = {
    tokensUsed: 0,
    chat: vi.fn(async (messages: ChatMessage[], options: ChatOptions) => {
      calls.push({ messages, options });
      const next = replies.shift();
      if (!next) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return {
        text: next.text,
        finishReason: next.finishReason ?? "stop",
        tokens: 1,
        estimated: false,
      };
    }),
  };
  return { client, calls };
}

async function failure(promise: Promise<unknown>): Promise<GenerationFailure> {
  try {
    await promise;
  } catch (error) {
    return error as GenerationFailure;
  }
  throw new Error("expected a failure");
}

describe("buildMessages", () => {
  it("gives the guidance and rules in the system message and the plan as delimited data", () => {
    const [system, user] = buildMessages(input, "PLAN-test");
    expect(system.content).toContain("Only the demo folder.");
    expect(system.content).toContain(`You write ${dir}demo.tsx`);
    expect(system.content).toContain(`demo:${SLUG}:`);
    expect(system.content).toContain(CANNOT_BUILD);
    expect(system.content).toContain("<<<PLAN-test>>>");
    expect(user.content).toContain("<<<CONTEXT src/components/ui/button.tsx>>>");
    expect(user.content).toContain(`<<<PLAN-test>>>\n${input.planText}\n<<<END-PLAN-test>>>`);
    expect(String(user.content).trimEnd().endsWith("rules in the system message.")).toBe(true);
    expect(system.content).not.toContain("This is a revision");
  });

  it("adds the current files and the feedback for a revision, each delimited", () => {
    const ids = ["x", "c1", "f1"];
    const [system, user] = buildMessages(
      {
        ...input,
        revision: {
          files: [{ path: `${dir}demo.tsx`, content: "// has <<<CURRENT-x>>> in it\n" }],
          feedback: ["Review: Use a button.", "On demo.tsx line 2: Rename it."],
        },
      },
      "PLAN-test",
      () => ids.shift() as string,
    );
    expect(system.content).toContain("This is a revision");
    expect(system.content).toContain("<<<CURRENT-c1 path>>>");
    expect(system.content).toContain("<<<FEEDBACK-f1>>>");
    expect(user.content).toContain(
      `<<<CURRENT-c1 ${dir}demo.tsx>>>\n// has <<<CURRENT-x>>> in it\n<<<END-CURRENT-c1>>>`,
    );
    expect(user.content).toContain(
      "<<<FEEDBACK-f1>>>\nReview: Use a button.\n\nOn demo.tsx line 2: Rename it.\n<<<END-FEEDBACK-f1>>>",
    );
  });
});

describe("generateDemo", () => {
  it("returns the workflow's page and loader plus the validated files", async () => {
    const llm = fakeLlm({ text: goodReply });
    const files = await generateDemo(llm.client, input);
    expect(files).toEqual([
      { path: `${dir}page.tsx`, content: pageTemplate("Counter demo") },
      { path: `${dir}demo-loader.tsx`, content: loaderTemplate() },
      { path: `${dir}demo.tsx`, content: `${demo}\n` },
      { path: `${dir}demo.test.tsx`, content: `${test}\n` },
    ]);
    expect(llm.calls[0].options).toEqual({ maxOutputTokens: 12_000, timeoutMs: 240_000 });
  });

  it("lints the full set, and retries with lint problems", async () => {
    const lint = vi
      .fn<(files: { path: string }[]) => Promise<string[]>>()
      .mockResolvedValueOnce([`"${dir}demo.tsx": lint no-restricted-globals at line 3`])
      .mockResolvedValueOnce([]);
    const llm = fakeLlm({ text: goodReply }, { text: goodReply });
    await generateDemo(llm.client, input, { lint });
    expect(lint.mock.calls[0][0].map((file) => file.path)).toContain(`${dir}page.tsx`);
    expect(llm.calls[1].messages.at(-1)?.content).toContain("no-restricted-globals");
  });

  it("asks once more with the problems listed, without echoing the reply", async () => {
    const bad = block("demo.tsx", 'export const x = fetch("/x");');
    const llm = fakeLlm({ text: bad }, { text: goodReply });
    const files = await generateDemo(llm.client, input);
    expect(files).toHaveLength(4);
    const retry = llm.calls[1].messages;
    expect(retry.at(-1)?.content).toContain("makes network calls");
    expect(retry.some((m) => m.role === "assistant")).toBe(false);
  });

  it.each([
    [
      "two invalid answers",
      [{ text: block("demo.tsx", "x") }, { text: block("demo.tsx", "y") }],
      "invalid_files",
    ],
    [
      "two malformed answers",
      [{ text: "nothing" }, { text: `<<<FILE ${dir}demo.tsx>>>\nunfinished` }],
      "unusable_reply",
    ],
    ["a decline", [{ text: CANNOT_BUILD }], "declined"],
    [
      "a cut-off reply",
      [{ text: goodReply.slice(0, 40), finishReason: "length" }],
      "reply_truncated",
    ],
    ["a filtered reply", [{ text: goodReply, finishReason: "content_filter" }], "unusable_reply"],
  ])("stops for a human after %s", async (_name, replies, reason) => {
    const llm = fakeLlm(...(replies as Reply[]));
    expect((await failure(generateDemo(llm.client, input))).reason).toBe(reason);
  });

  it("refuses plans that carry code or markers, without calling the model", async () => {
    for (const planText of ["Title\n```ts\nfetch()\n```", `Title\n<<<FILE ${dir}demo.tsx>>>`]) {
      const llm = fakeLlm();
      const error = await failure(generateDemo(llm.client, { ...input, planText }));
      expect(error.reason).toBe("plan_refused");
      expect(llm.calls).toHaveLength(0);
    }
  });

  it("lets model errors such as the token cap through", async () => {
    const llm = fakeLlm(new LlmError("cap_exceeded", "x"));
    await expect(generateDemo(llm.client, input)).rejects.toBeInstanceOf(LlmError);
  });
});
