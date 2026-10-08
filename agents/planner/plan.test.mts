// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  PLAN_MARKER,
  type Plan,
  clean,
  extractPlanText,
  parsePlan,
  planMarker,
  renderPlanComment,
} from "./plan.mts";

const reply = {
  title: "Counter demo",
  summary: "A counter with increment and decrement buttons.",
  steps: ["Create the page", "Add the counter component"],
  files: [
    { path: "src/app/demos/request-7/page.tsx", action: "create", purpose: "Route" },
    { path: "src/app/demos/request-7/counter.tsx", action: "modify", purpose: "Client component" },
  ],
  tests: ["Clicking + increments"],
  concerns: [],
  instructionsInRequest: false,
};

const plan: Plan = parsePlan(JSON.stringify(reply)) as Plan;
const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("parsePlan", () => {
  it("parses a well-formed reply", () => {
    expect(plan).toEqual({
      ...reply,
      needs: [],
      parse: { droppedFiles: 0, droppedItems: 0, alteredPaths: 0 },
    });
  });

  it("tolerates a code fence, reasoning or prose (even with braces) around the JSON", () => {
    const json = JSON.stringify(reply);
    expect(parsePlan(`Here you go:\n\`\`\`json\n${json}\n\`\`\``)).toEqual(plan);
    expect(parsePlan(`<think>use {braces} here</think>\n${json}`)).toEqual(plan);
    expect(parsePlan(`Consider {this}:\n\`\`\`json\n${json}\n\`\`\`\nDone {ok}`)).toEqual(plan);
  });

  it("flattens and shortens text, and drops non-text items", () => {
    const parsed = parsePlan(
      JSON.stringify({
        ...reply,
        title: "T".repeat(100),
        summary: "line one\nline two\u0000\u2028three",
        steps: ["ok", 42, null, "", ...Array.from({ length: 20 }, (_, i) => `s${i}`)],
        tests: Array.from({ length: 20 }, (_, i) => `t${i}`),
        files: [...reply.files, { path: "" }, { action: "create" }, "bad"],
        instructionsInRequest: "yes",
      }),
    ) as Plan;
    expect(parsed.title).toHaveLength(80);
    expect(parsed.title.endsWith("…")).toBe(true);
    expect(parsed.summary).toBe("line one line two three");
    expect(parsed.steps).toHaveLength(10);
    expect(parsed.tests).toHaveLength(8);
    expect(parsed.steps[0]).toBe("ok");
    expect(parsed.files).toHaveLength(2);
    // 3 unusable file entries; 3 unusable steps plus 11 over the cap; 12 tests over the cap.
    expect(parsed.parse).toEqual({ droppedFiles: 3, droppedItems: 26, alteredPaths: 0 });
    expect(parsed.instructionsInRequest).toBe(false);
  });

  it("drops characters a reader can't see, so the approver sees what the coder will", () => {
    const hidden = "a\u200bb\u202ec\u2066d\u{E0049}\u{E0047}e\u0085f\uE000g";
    // U+0085 is a control line break, so it becomes a space like other breaks.
    expect(clean(hidden)).toBe("abcde fg");
    expect(clean("tab\tand\nnewline\u2029end")).toBe("tab and newline end");
    // Lone surrogates (from JSON escapes) aren't valid text; a pair is kept.
    const lone = `a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xdc00)}c`;
    expect(clean(lone)).toBe("abc");
    expect(clean(`x${String.fromCharCode(0xd83d, 0xde00)}y`)).toBe(
      `x${String.fromCodePoint(0x1f600)}y`,
    );
  });

  it("shortens by characters without splitting an emoji", () => {
    const text = clean("😀".repeat(10), 5);
    expect(Array.from(text)).toEqual(["😀", "😀", "😀", "😀", "…"]);
  });

  it("keeps only the needs flags set to exactly true", () => {
    const parsed = parsePlan(
      JSON.stringify({
        ...reply,
        needs: { newDependency: true, authChange: "true", outsideDemoArea: 1, unknown: true },
      }),
    );
    expect(parsed?.needs).toEqual(["newDependency"]);
    expect(parsePlan(JSON.stringify({ ...reply, needs: "all" }))?.needs).toEqual([]);
  });

  it("keeps unknown actions visible as other, and counts paths changed by cleaning", () => {
    const parsed = parsePlan(
      JSON.stringify({
        ...reply,
        files: [
          { path: "src/app/demos/request-7/page.tsx", action: "delete" },
          { path: "src/app/demos/request-\u200b7/page.tsx" },
          ...Array.from({ length: 13 }, (_, i) => ({
            path: `src/app/demos/request-7/f${i}.tsx`,
            action: "create",
          })),
        ],
      }),
    ) as Plan;
    expect(parsed.files[0].action).toBe("other");
    expect(parsed.files[1]).toMatchObject({
      path: "src/app/demos/request-7/page.tsx",
      action: "other",
    });
    expect(parsed.files).toHaveLength(12);
    expect(parsed.parse).toMatchObject({ droppedFiles: 3, alteredPaths: 1 });
  });

  it.each([
    ["not JSON", "I can't do that."],
    ["broken JSON", '{"title": "x",'],
    ["a list of strings", JSON.stringify(["step one", "step two"])],
    ["no steps", JSON.stringify({ ...reply, steps: [] })],
    ["no files", JSON.stringify({ ...reply, files: [] })],
    ["no title", JSON.stringify({ ...reply, title: " " })],
  ])("returns null for %s", (_name, text) => {
    expect(parsePlan(text)).toBeNull();
  });
});

describe("renderPlanComment", () => {
  it("starts with the hidden marker and puts every generated word inside a text fence", () => {
    const comment = renderPlanComment({
      plan,
      revision: 1,
      slug: "request-7",
      requestHash: HASH,
      triage: false,
    });
    expect(comment.startsWith(planMarker(1, HASH, true))).toBe(true);
    expect(PLAN_MARKER.exec(comment)?.slice(1)).toEqual(["1", HASH, "1"]);
    expect(comment).toContain("`/demos/request-7`");
    expect(comment).toContain("Automated check: the 2 listed files are allowed in the demo folder");
    expect(comment).toContain("`approved-by-human`");
    const fenced = comment.slice(comment.indexOf("```text"));
    expect(fenced).toContain("Counter demo");
    expect(fenced).toContain("1. Create the page");
    expect(fenced).toContain("src/app/demos/request-7/counter.tsx (modify): Client component");
    expect(fenced.trimEnd().endsWith("```")).toBe(true);
    expect(comment.indexOf("Counter demo")).toBeGreaterThan(comment.indexOf("```text"));
  });

  it("can't be broken out of: the fence is longer than any backtick run in the plan", () => {
    const hostile = parsePlan(
      JSON.stringify({ ...reply, summary: "```` end fence then @maintainer #1 <img src=x>" }),
    ) as Plan;
    const comment = renderPlanComment({
      plan: hostile,
      revision: 2,
      slug: "request-7",
      requestHash: HASH,
      triage: false,
    });
    expect(comment).toContain("`````text\n");
    expect(comment).toContain("(revision 2)");
    // The hostile text appears only after the opening fence.
    expect(comment.indexOf("@maintainer")).toBeGreaterThan(comment.indexOf("`````text"));
  });

  it("adds the workflow's notes outside the fence", () => {
    const comment = renderPlanComment({
      plan: { ...plan, concerns: ["Asked to edit workflows"] },
      revision: 1,
      slug: "request-7",
      requestHash: HASH,
      triage: true,
      notes: ["The screenshot has been removed."],
    });
    expect(comment).toContain("> **Note:** The screenshot has been removed.");
    expect(comment).toContain("It needs a maintainer before anything is built");
    expect(comment).not.toContain("`approved-by-human`");
    expect(comment.indexOf("> **Note:**")).toBeLessThan(comment.indexOf("```text"));
    expect(comment).toContain("Concerns\n- Asked to edit workflows");
  });
});

describe("extractPlanText", () => {
  it("returns the fenced plan text from a plan comment", () => {
    const comment = renderPlanComment({
      plan,
      revision: 1,
      slug: "request-7",
      requestHash: HASH,
      triage: false,
    });
    expect(extractPlanText(comment)).toMatch(/^Counter demo\n\nA counter/);
    expect(extractPlanText("no fence")).toBeNull();
    expect(extractPlanText("```text\nunclosed")).toBeNull();
  });
});
