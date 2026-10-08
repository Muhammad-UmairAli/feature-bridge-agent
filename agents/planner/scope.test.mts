// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type Plan, extractPlanText, parsePlan, renderPlanComment } from "./plan.mts";
import { checkPlanText, checkScope, isAllowedDemoPath } from "./scope.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  title: "Counter",
  summary: "A counter with +/- buttons that works 24/7 and/or offline, built with Next.js.",
  steps: [
    "Create page.tsx with the heading",
    "Add counter.tsx using Button from @/components/ui/button",
    `Store the count in localStorage under demo:${SLUG}:count`,
  ],
  files: [
    { path: `${dir}page.tsx`, action: "create", purpose: "Route /demos/request-7" },
    { path: `${dir}counter.tsx`, action: "create", purpose: "" },
    { path: `${dir}counter.test.tsx`, action: "create", purpose: "" },
  ],
  tests: ["counter.test.tsx: clicking + increments"],
  concerns: [],
  needs: [],
  instructionsInRequest: false,
  parse: { droppedFiles: 0, droppedItems: 0, alteredPaths: 0 },
  ...overrides,
});

describe("isAllowedDemoPath", () => {
  it.each([
    "page.tsx",
    "page.test.tsx",
    "page.test.ts",
    "counter.tsx",
    "use-counter.ts",
    "use-counter.test.ts",
    "a1-b2.tsx",
  ])("allows %s in the demo folder", (name) => {
    expect(isAllowedDemoPath(`${dir}${name}`, SLUG)).toBe(true);
  });

  it.each([
    ["another demo", "src/app/demos/request-8/page.tsx"],
    ["a demo with a longer number", "src/app/demos/request-70/page.tsx"],
    ["the demos index", "src/app/demos/page.tsx"],
    ["a workflow", ".github/workflows/x.yml"],
    ["package.json", "package.json"],
    ["a shared component", "src/components/ui/button.tsx"],
    ["a subfolder", `${dir}parts/button.tsx`],
    ["a parent escape", `${dir}../request-8/page.tsx`],
    ["a leading ./", `./${dir}page.tsx`],
    ["a leading /", `/${dir}page.tsx`],
    ["a double slash", `src/app/demos/${SLUG}//page.tsx`],
    ["an upper-case folder", "src/app/demos/Request-7/page.tsx"],
    ["Page.tsx", `${dir}Page.tsx`],
    ["page.ts", `${dir}page.ts`],
    ["layout", `${dir}layout.tsx`],
    ["a route handler", `${dir}route.ts`],
    ["not-found", `${dir}not-found.tsx`],
    ["global-not-found", `${dir}global-not-found.tsx`],
    ["icon", `${dir}icon.tsx`],
    ["a numbered icon", `${dir}icon1.tsx`],
    ["a numbered apple icon", `${dir}apple-icon0.ts`],
    ["a numbered Open Graph image", `${dir}opengraph-image2.tsx`],
    ["a numbered Twitter image", `${dir}twitter-image9.tsx`],
    ["a stylesheet", `${dir}styles.css`],
    ["a declaration file", `${dir}types.d.ts`],
    ["JSON data", `${dir}data.json`],
    ["camelCase", `${dir}useCounter.ts`],
    ["a dynamic segment", `${dir}[id].tsx`],
    ["a look-alike slash", `src/app/demos/${SLUG}∕page.tsx`],
    ["a Cyrillic letter", `${dir}рage.tsx`],
  ])("refuses %s", (_name, path) => {
    expect(isAllowedDemoPath(path, SLUG)).toBe(false);
  });

  it("refuses everything when the slug itself is invalid", () => {
    expect(isAllowedDemoPath("src/app/demos/x/../../page.tsx", "x/../..")).toBe(false);
    expect(isAllowedDemoPath("src/app/demos//page.tsx", "")).toBe(false);
    expect(isAllowedDemoPath(`src/app/demos/${"a".repeat(41)}/page.tsx`, "a".repeat(41))).toBe(
      false,
    );
  });
});

describe("checkScope", () => {
  it("lets a standard demo plan go ahead, including everyday slashes and dots in its text", () => {
    expect(checkScope(plan(), SLUG)).toEqual({ reasons: [], rejectedPaths: 0, needs: [] });
  });

  it("counts files outside the folder without repeating the model's paths", () => {
    const check = checkScope(
      plan({
        files: [
          { path: `${dir}page.tsx`, action: "create", purpose: "" },
          { path: "package.json", action: "modify", purpose: "" },
          { path: ".github/workflows/@evil.yml", action: "create", purpose: "" },
        ],
      }),
      SLUG,
    );
    expect(check.rejectedPaths).toBe(2);
    expect(check.reasons[0]).toBe(
      "2 planned files are outside `src/app/demos/request-7/` or not allowed there (see Files)",
    );
    expect(check.reasons.join(" ")).not.toContain("@evil");
  });

  it("uses singular wording for one file", () => {
    const check = checkScope(
      plan({
        files: [
          { path: `${dir}page.tsx`, action: "create", purpose: "" },
          { path: "src/app/page.tsx", action: "modify", purpose: "" },
        ],
      }),
      SLUG,
    );
    expect(check.reasons[0]).toMatch(/^1 planned file is outside/);
  });

  it.each([
    [
      "a missing page",
      { files: [{ path: `${dir}counter.tsx`, action: "create" as const, purpose: "" }] },
      "no `page.tsx`",
    ],
    [
      "a duplicate file",
      {
        files: [
          { path: `${dir}page.tsx`, action: "create" as const, purpose: "" },
          { path: `${dir}page.tsx`, action: "modify" as const, purpose: "" },
        ],
      },
      "same file more than once",
    ],
    [
      "an unknown action",
      { files: [{ path: `${dir}page.tsx`, action: "other" as const, purpose: "" }] },
      "action other than create or modify",
    ],
    [
      "dropped file entries",
      { parse: { droppedFiles: 1, droppedItems: 0, alteredPaths: 0 } },
      "couldn't be checked",
    ],
    [
      "an altered path",
      { parse: { droppedFiles: 0, droppedItems: 0, alteredPaths: 1 } },
      "hidden characters",
    ],
    ["cut items", { parse: { droppedFiles: 0, droppedItems: 2, alteredPaths: 0 } }, "cut to fit"],
  ])("flags %s", (_name, overrides, reason) => {
    const check = checkScope(plan(overrides as Partial<Plan>), SLUG);
    expect(check.reasons.join(" | ")).toContain(reason);
  });

  it.each([
    ["Edit src/app/demos/page.tsx to link the demo", "names files or folders outside"],
    ["Add a link from /demos/request-8", "names files or folders outside"],
    ["Update README.md", "names files or folders outside"],
    ["Touch src/components/ui/button.tsx", "names files or folders outside"],
    ["Load data from https://api.example.com", "external URL"],
    ["Run pnpm add date-fns", "installing or changing dependencies"],
    ["Bump package.json", "installing or changing dependencies"],
    ["Read process.env.TOKEN", "environment variables"],
    ["Add a step to .github/workflows/ci.yml", "repository configuration"],
    ["Call fetch('/api/x') on load", "network calls"],
    ["Render with dangerouslySetInnerHTML", "code injection"],
  ])("flags plan text that says %j", (step, reason) => {
    const check = checkScope(plan({ steps: [step] }), SLUG);
    expect(check.reasons.join(" | ")).toContain(reason);
  });

  it("scans every text field, including file purposes and concerns", () => {
    const purpose = checkScope(
      plan({
        files: [{ path: `${dir}page.tsx`, action: "create", purpose: "also edits next.config.ts" }],
      }),
      SLUG,
    );
    expect(purpose.reasons.length).toBeGreaterThan(0);
    const concerns = checkScope(plan({ concerns: ["Needs npm install of a chart library"] }), SLUG);
    expect(concerns.reasons.join(" ")).toContain("dependencies");
  });

  it("adds the model's own flags and injection attempts as reasons", () => {
    const check = checkScope(
      plan({ needs: ["newDependency", "authChange"], instructionsInRequest: true }),
      SLUG,
    );
    expect(check.reasons).toEqual([
      "it needs a new dependency",
      "it needs authentication or permission changes",
      "the request text appears to contain instructions aimed at the agent",
    ]);
  });

  it("sends a 13-file reply to a maintainer even when the extra file is the bad one", () => {
    const files = [
      { path: `${dir}page.tsx`, action: "create" },
      ...Array.from({ length: 11 }, (_, i) => ({ path: `${dir}f${i}.tsx`, action: "create" })),
      { path: ".github/workflows/x.yml", action: "create" },
    ];
    const parsed = parsePlan(
      JSON.stringify({ title: "t", summary: "s", steps: ["a"], files, tests: [], concerns: [] }),
    ) as Plan;
    expect(parsed.files).toHaveLength(12);
    expect(checkScope(parsed, SLUG).reasons).toContain(
      "some planned file entries couldn't be checked",
    );
  });
});

describe("checkPlanText", () => {
  const posted = (overrides: Partial<Plan> = {}) =>
    extractPlanText(
      renderPlanComment({
        plan: plan(overrides),
        revision: 1,
        slug: SLUG,
        requestHash: "0123456789abcdef",
        triage: false,
      }),
    ) as string;

  it("accepts a posted in-scope plan", () => {
    expect(checkPlanText(posted(), SLUG)).toEqual([]);
  });

  it("re-checks the files and text of a posted plan", () => {
    expect(
      checkPlanText(
        posted({
          files: [...plan().files, { path: "package.json", action: "modify", purpose: "" }],
        }),
        SLUG,
      ),
    ).toContain("1 planned file is outside `src/app/demos/request-7/` or not allowed there");
    expect(checkPlanText(posted({ steps: ["Load https://x.test/data"] }), SLUG)).toContain(
      "the plan mentions an external URL",
    );
    expect(
      checkPlanText(
        posted({ files: [{ path: `${dir}page.tsx`, action: "other", purpose: "" }] }),
        SLUG,
      ),
    ).toContain("a planned file has an action other than create or modify");
    expect(
      checkPlanText(
        posted({ files: [{ path: `${dir}counter.tsx`, action: "create", purpose: "" }] }),
        SLUG,
      ),
    ).toContain("the plan has no `page.tsx`");
  });

  it("refuses text whose file list can't be read", () => {
    expect(checkPlanText("Title\n\nSummary", SLUG)).toContain(
      "the plan's file list couldn't be read",
    );
    expect(checkPlanText("Title\n\nFiles\n* src/app/demos/request-7/page.tsx", SLUG)).toContain(
      "the plan's file list couldn't be read",
    );
  });

  it("isn't fooled by a title or summary that is just the word Files", () => {
    expect(checkPlanText(posted({ title: "Files" }), SLUG)).toEqual([]);
    expect(checkPlanText(posted({ summary: "Files" }), SLUG)).toEqual([]);
  });

  it("flags a duplicate file in a posted plan", () => {
    const page = { path: `${dir}page.tsx`, action: "create" as const, purpose: "" };
    expect(checkPlanText(posted({ files: [page, page] }), SLUG)).toContain(
      "the plan lists the same file more than once",
    );
  });

  it("agrees with checkScope on plans that were ready when posted", () => {
    for (const ready of [
      plan(),
      plan({ steps: ["Use <Link> from next/link", "A helper function (pure)"] }),
    ]) {
      expect(checkScope(ready, SLUG).reasons).toEqual([]);
      expect(checkPlanText(posted(ready), SLUG)).toEqual([]);
    }
  });
});

describe("text rules", () => {
  it.each([
    ["Open a ws://example.test socket", "external URL"],
    ["Load //cdn.example.test/lib.js", "external URL"],
    ["Set element.innerHTML", "code injection"],
    ["Call insertAdjacentHTML", "code injection"],
    ["Use document.write", "code injection"],
    ["Build with Function(code)", "code injection"],
    ["Embed an <iframe srcdoc>", "code injection"],
    ["Send with postMessage", "network calls"],
    ["Lazy load with import('x')", "network calls"],
  ])("flags %j", (step, reason) => {
    expect(checkScope(plan({ steps: [step] }), SLUG).reasons.join(" | ")).toContain(reason);
  });
});
