// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CANNOT_BUILD, FILE_END, type GeneratedFile, parseFiles, validateFiles } from "./files.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const char = (code: number) => String.fromCodePoint(code);

const demo = `"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

const KEY = "demo:${SLUG}:count";

export default function Demo() {
  const [count, setCount] = useState(() => Number(localStorage.getItem("demo:${SLUG}:count") ?? 0));
  return (
    <div>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-hidden="true">
        <circle cx="5" cy="5" r="4" />
      </svg>
      <Button onClick={() => setCount(count + 1)}>Count {count}</Button>
      <p>A line from "Hamlet" and the word process, or (at least) a headers table.</p>
    </div>
  );
}
export const unused = KEY;
`;
const test = `import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Demo from "./demo";

describe("Demo", () => {
  it("renders", () => {
    vi.useFakeTimers();
    render(<Demo />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});
`;

const good: GeneratedFile[] = [
  { path: `${dir}demo.tsx`, content: demo },
  { path: `${dir}demo.test.tsx`, content: test },
];
const withDemo = (content: string) =>
  good.map((file) => (file.path.endsWith("demo.tsx") ? { ...file, content } : file));
const withTest = (content: string) =>
  good.map((file) => (file.path.endsWith(".test.tsx") ? { ...file, content } : file));

describe("parseFiles", () => {
  const block = (path: string, lines: string[]) => [`<<<FILE ${dir}${path}>>>`, ...lines, FILE_END];

  it("reads delimited files, ignoring prose and a leading reasoning block", () => {
    const reply = [
      "<think>plan it</think>Here you go:",
      ...block("demo.tsx", ["line 1", "", "line 3"]),
      "and the test:",
      ...block("demo.test.tsx", ["test"]),
    ].join("\r\n");
    expect(parseFiles(reply)).toEqual({
      kind: "files",
      files: [
        { path: `${dir}demo.tsx`, content: "line 1\n\nline 3\n" },
        { path: `${dir}demo.test.tsx`, content: "test\n" },
      ],
    });
  });

  it("tolerates whitespace around markers and strips one wrapping code fence", () => {
    const reply = [
      `  <<<FILE ${dir}demo.tsx>>>  `,
      "```tsx",
      "code();",
      "```",
      `${FILE_END} `,
    ].join("\n");
    expect(parseFiles(reply)).toEqual({
      kind: "files",
      files: [{ path: `${dir}demo.tsx`, content: "code();\n" }],
    });
  });

  it("recognises a decline", () => {
    expect(parseFiles(`I can't.\n${CANNOT_BUILD}`)).toEqual({ kind: "declined" });
  });

  it.each([
    ["an unclosed block", [`<<<FILE ${dir}demo.tsx>>>`, "unfinished"], "wasn't closed"],
    [
      "a block opened inside another",
      [`<<<FILE ${dir}demo.tsx>>>`, "x", `<<<FILE ${dir}b.tsx>>>`, "y", FILE_END],
      "before the next one",
    ],
    ["a stray end marker", ["prose", FILE_END], "outside a file block"],
    ["a malformed start marker", ["<<<FILE has spaces in it>>>"], "malformed"],
    [
      "an end marker inside a file",
      [`<<<FILE ${dir}demo.tsx>>>`, "a", FILE_END, "b", FILE_END],
      "outside a file block",
    ],
  ])("reports %s", (_name, lines, problem) => {
    const result = parseFiles(lines.join("\n"));
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.problem).toContain(problem);
  });

  it("returns no files for prose only", () => {
    expect(parseFiles("I can't do that.")).toEqual({ kind: "files", files: [] });
  });
});

describe("validateFiles", () => {
  it("accepts an ordinary demo, including inline SVG, prose that looks like code, and allowed vi helpers", () => {
    expect(validateFiles(good, SLUG)).toEqual([]);
  });

  it.each([
    ["no files", [], "no files were returned"],
    ["no demo", good.slice(1), `no ${dir}demo.tsx`],
    ["no test", good.slice(0, 1), "no test file"],
    ["a duplicate", [...good, good[0]], "the same file appears more than once"],
    [
      "a page written by the model",
      [...good, { path: `${dir}page.tsx`, content: "x" }],
      "written by the workflow",
    ],
    [
      "a loader written by the model",
      [...good, { path: `${dir}demo-loader.tsx`, content: "x" }],
      "written by the workflow",
    ],
    [
      "another demo's folder",
      [...good, { path: "src/app/demos/request-8/demo.tsx", content: "x" }],
      "not an allowed file",
    ],
    [
      "a file outside the folder",
      [...good, { path: "package.json", content: "{}" }],
      "not an allowed file",
    ],
    [
      "a demo without use client",
      withDemo(demo.replace('"use client";', "")),
      'must start with "use client"',
    ],
    [
      "a demo without a default export",
      withDemo(demo.replace("export default function", "export function")),
      "default export function",
    ],
    ["page settings", withDemo(`${demo}export const metadata = {};\n`), "exports page settings"],
    [
      "environment variables",
      withDemo(`${demo}export const k = process.env.KEY;\n`),
      "Node APIs or the environment",
    ],
    [
      "a server action",
      withDemo(`${demo}export async function save() {\n  "use server";\n}\n`),
      "defines server actions",
    ],
    [
      "a network call",
      withDemo(`${demo}export const load = () => fetch("/x");\n`),
      "makes network calls",
    ],
    [
      "a cookie",
      withDemo(`${demo}export const c = () => document.cookie;\n`),
      "storage other than",
    ],
    [
      "a navigation write",
      withDemo(`${demo}export const go = () => { window.location.href = "/x"; };\n`),
      "navigates away",
    ],
    [
      "an external link",
      withDemo(`${demo}export const url = "https://example.test";\n`),
      "points outside the site",
    ],
    [
      "a protocol-relative URL",
      withDemo(`${demo}export const url = "//cdn.example.test/x.js";\n`),
      "points outside the site",
    ],
    [
      "injected HTML",
      withDemo(`${demo}export const X = () => <div dangerouslySetInnerHTML={{ __html: "" }} />;\n`),
      "injects HTML",
    ],
    [
      "an iframe",
      withDemo(`${demo}export const F = () => <iframe title="x" />;\n`),
      "embeds scripts or external content",
    ],
    [
      "createElement",
      withDemo(`${demo}export const s = () => document.createElement("div");\n`),
      "embeds scripts",
    ],
    [
      "eval",
      withDemo(`${demo}export const run = (s: string) => eval(s);\n`),
      "evaluates strings as code",
    ],
    [
      "a string timer",
      withDemo(`${demo}export const t = () => setTimeout("go()", 1);\n`),
      "evaluates strings as code",
    ],
    [
      "a dynamic import",
      withDemo(`${demo}export const load = () => import("./x");\n`),
      "loads modules dynamically",
    ],
    ["globalThis", withDemo(`${demo}export const g = globalThis;\n`), "reaches globals indirectly"],
    [
      "computed window access",
      withDemo(`${demo}export const f = window["fe" + "tch"];\n`),
      "reaches globals indirectly",
    ],
    [
      "a constructor escape",
      withDemo(`${demo}export const c = (() => 1).constructor;\n`),
      "reaches globals indirectly",
    ],
    [
      "an escaped string",
      withDemo(`${demo}export const s = "\\u0070rocess";\n`),
      "builds hidden strings",
    ],
    ["atob", withDemo(`${demo}export const s = atob("eA==");\n`), "builds hidden strings"],
    ["a jsx pragma", withDemo(`/** @jsx h */\n${demo}`), "changes how the file is compiled"],
    [
      "a test environment switch",
      withTest(`// @vitest-environment node\n${test}`),
      "changes how the file is compiled",
    ],
    [
      "vi.mock",
      withTest(test.replace("vi.useFakeTimers();", 'vi.mock("./demo");')),
      "uses vi.mock",
    ],
    [
      "vi.importActual",
      withTest(test.replace("vi.useFakeTimers();", 'vi.importActual("x");')),
      "uses vi.importActual",
    ],
    [
      "a new dependency",
      withDemo(`import dayjs from "dayjs";\n${demo}`),
      "imports a module demos may not use",
    ],
    [
      "an internal module",
      withDemo(`import { log } from "@/lib/log";\n${demo}`),
      "imports a module demos may not use",
    ],
    [
      "a test library in demo code",
      withDemo(`import { vi } from "vitest";\n${demo}`),
      "imports a module demos may not use",
    ],
    [
      "redirect from next/navigation",
      withDemo(`import { redirect as go } from "next/navigation";\n${demo}`),
      "next/navigation other than",
    ],
    [
      "a namespace import of next/navigation",
      withDemo(`import * as nav from "next/navigation";\n${demo}`),
      "next/navigation other than",
    ],
    [
      "a missing own file",
      withTest(test.replace("./demo", "./missing")),
      "imports a file it doesn't create",
    ],
    [
      "an unprefixed storage key",
      withDemo(
        demo.replace(`localStorage.getItem("demo:${SLUG}:count")`, 'localStorage.getItem("count")'),
      ),
      "literal strings starting with",
    ],
    [
      "a variable storage key",
      withDemo(
        demo.replace(`localStorage.getItem("demo:${SLUG}:count")`, "localStorage.getItem(KEY)"),
      ),
      "literal strings starting with",
    ],
    [
      "clearing storage",
      withDemo(`${demo}export const c = () => localStorage.clear();\n`),
      "uses clear on browser storage",
    ],
    [
      "index access on storage",
      withDemo(`${demo}export const c = () => localStorage["x"];\n`),
      "index access",
    ],
    ["a suppression comment", withDemo(`// @ts-nocheck\n${demo}`), "suppression"],
    [
      "a zero-width space",
      withDemo(demo.replace("Count", `Co${char(0x200b)}unt`)),
      "hidden characters",
    ],
    [
      "a line separator",
      withDemo(demo.replace("Count", `Co${char(0x2028)}unt`)),
      "hidden characters",
    ],
    [
      "a Hangul filler",
      withDemo(demo.replace("const KEY", `const K${char(0x3164)}EY`)),
      "hidden characters",
    ],
    [
      "a variation selector",
      withDemo(demo.replace("Count", `Count${char(0xfe0f)}`)),
      "hidden characters",
    ],
    [
      "a very long line",
      withDemo(`${demo}export const s = "${"x".repeat(400)}";\n`),
      "longer than 300 characters",
    ],
  ])("refuses %s", (_name, files, problem) => {
    expect(validateFiles(files as GeneratedFile[], SLUG).join(" | ")).toContain(problem);
  });

  it.each([
    ["reading location.href", `${demo}export const here = () => window.location.href;\n`],
    ["a generic object type", `${demo}export const list: Array<object> = [];\n`],
    [
      "an own component named Embed",
      `${demo}const Embed = () => null;\nexport const E = () => <Embed />;\n`,
    ],
    ["a local replace call", `${demo}export const slug = (s: string) => s.replace(" ", "-");\n`],
    [
      "an import with a .tsx extension",
      demo.replace('from "react";', 'from "react";\nimport Again from "./demo.tsx";'),
    ],
    [
      "router hooks",
      demo.replace('from "react";', 'from "react";\nimport { useRouter } from "next/navigation";'),
    ],
  ])("doesn't refuse %s", (_name, content) => {
    expect(validateFiles(withDemo(content), SLUG)).toEqual([]);
  });

  it("limits the number and size of files", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      path: `${dir}f${i}.ts`,
      content: "export {};\n",
    }));
    expect(validateFiles([...good, ...many], SLUG).join(" | ")).toContain("more than 12 files");
    const lines = Array.from(
      { length: 200 },
      (_, i) => `export const v${i} = "${"x".repeat(200)}";`,
    ).join("\n");
    expect(
      validateFiles([...good, { path: `${dir}data.ts`, content: lines }], SLUG).join(" | "),
    ).toContain("larger than 30000 bytes");
  });
});
