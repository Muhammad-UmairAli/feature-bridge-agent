// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  checkChanges,
  checkContent,
  classify,
  isSha,
  parseRawLog,
  shown,
  slugForBranch,
} from "./check.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const BLOB = "b".repeat(40);
const change = (status: string, path: string, oldMode = "100644", newMode = "100644") => ({
  status,
  path,
  newBlob: status === "D" ? "0".repeat(40) : BLOB,
  oldMode: status === "A" ? "000000" : oldMode,
  newMode: status === "D" ? "000000" : newMode,
});
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("slugForBranch", () => {
  it("maps request branches to their demo folder and ignores others", () => {
    expect(slugForBranch("request-7")).toBe("request-7");
    for (const branch of [
      "main",
      "feature/x",
      "request-0",
      "request-07",
      "request-7/x",
      "Request-7",
    ]) {
      expect(slugForBranch(branch)).toBeNull();
    }
  });
});

describe("isSha", () => {
  it("accepts only full commit ids", () => {
    expect(isSha("a".repeat(40))).toBe(true);
    expect(isSha("abc")).toBe(false);
    expect(isSha(`${"a".repeat(40)}\n`)).toBe(false);
  });
});

describe("parseRawLog", () => {
  it("reads modes, blob, status and paths, including odd file names", () => {
    const output = [
      `:000000 100644 ${"0".repeat(40)} ${BLOB} A`,
      `${dir}page.tsx`,
      `\n:100644 100755 ${BLOB} ${BLOB} M`,
      `${dir}odd name\nwith newline.ts`,
      "",
    ].join("\0");
    expect(parseRawLog(output)).toEqual([
      { oldMode: "000000", newMode: "100644", newBlob: BLOB, status: "A", path: `${dir}page.tsx` },
      {
        oldMode: "100644",
        newMode: "100755",
        newBlob: BLOB,
        status: "M",
        path: `${dir}odd name\nwith newline.ts`,
      },
    ]);
  });

  it("fails loudly on output it doesn't understand", () => {
    expect(() => parseRawLog("garbage\0")).toThrow("unexpected git log output");
    expect(() => parseRawLog(":000000 100644 0 1 A")).toThrow("unexpected git log output");
  });
});

describe("shown", () => {
  it("keeps log annotations to one line of printable ASCII", () => {
    const result = shown("a\nb%0A\u202ec");
    expect(result).toMatch(/^"[\x20-\x7e]*"$/);
    expect(result).not.toContain("%");
    expect(result).toContain("\\\\u000a");
    expect(shown("plain/path.ts")).toBe('"plain/path.ts"');
  });
});

describe("checkChanges", () => {
  it("accepts adding, changing and deleting regular demo files", () => {
    expect(
      checkChanges(
        [
          change("A", `${dir}page.tsx`),
          change("M", `${dir}counter.tsx`),
          change("D", `${dir}old.ts`),
        ],
        SLUG,
      ),
    ).toEqual([]);
  });

  it.each([
    ["a file outside the folder", change("M", "package.json")],
    ["a workflow", change("A", ".github/workflows/x.yml")],
    ["another demo", change("A", "src/app/demos/request-8/page.tsx")],
    ["the demos index", change("M", "src/app/demos/page.tsx")],
    ["deleting a file outside the folder", change("D", "src/app/page.tsx")],
    ["a route handler inside the folder", change("A", `${dir}route.ts`)],
    ["a symlink", change("A", `${dir}link.ts`, "000000", "120000")],
    ["a submodule", change("A", `${dir}sub.ts`, "000000", "160000")],
    ["an executable file", change("M", `${dir}run.ts`, "100644", "100755")],
    ["a type change", change("T", `${dir}page.tsx`, "100644", "120000")],
  ])("refuses %s", (_name, entry) => {
    const problems = checkChanges([entry], SLUG);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.startsWith(shown(entry.path)))).toBe(true);
  });

  it("quotes paths so they can't inject workflow commands", () => {
    const [problem] = checkChanges([change("A", "x\n::set-env name=A::1")], SLUG);
    expect(problem).not.toContain("\n");
  });
});

describe("checkContent", () => {
  it("accepts ordinary source, including tabs, CRLF and accents", () => {
    expect(
      checkContent(
        `${dir}page.tsx`,
        utf8('export default function Page() {\n\treturn "\u00e9";\r\n}\n'),
      ),
    ).toEqual([]);
  });

  it.each([
    ["too large", new Uint8Array(MAX_FILE_BYTES + 1), "larger than"],
    ["not UTF-8", new Uint8Array([0xff, 0xfe, 0x00]), "not valid UTF-8"],
    ["a NUL byte", utf8("a\u0000b"), "control or invisible"],
    ["a bidi override", utf8("const a = 1; /*\u202e*/"), "control or invisible"],
    ["a zero-width space", utf8("const a\u200b = 1;"), "control or invisible"],
    ["a byte-order mark", utf8("\ufeffexport {};"), "control or invisible"],
    ["eslint-disable", utf8("/* eslint-disable */\nfetch('/x');"), "suppression"],
    ["an eslint config comment", utf8("/* eslint no-restricted-globals: off */"), "suppression"],
    ["@ts-ignore", utf8("// @ts-ignore\nconst a: number = 'x';"), "suppression"],
    ["@ts-nocheck", utf8("// @ts-nocheck"), "suppression"],
  ])("refuses %s", (_name, bytes, problem) => {
    const problems = checkContent(`${dir}page.tsx`, bytes);
    expect(problems.join(" | ")).toContain(problem);
  });
});

describe("classify", () => {
  const agentPr = {
    headRef: "request-7",
    headRepo: "octo/requests",
    baseRepo: "octo/requests",
    baseRef: "main",
    author: "request-coder[bot]",
    agentLogin: "request-coder[bot]",
  };

  it("checks request branches opened by the agent into main", () => {
    expect(classify(agentPr)).toEqual({ kind: "request", slug: "request-7" });
  });

  it("lets other pull requests through", () => {
    expect(classify({ ...agentPr, headRef: "feature/x", author: "someone" })).toEqual({
      kind: "other",
    });
  });

  it.each([
    [
      "the agent on another branch",
      { headRef: "feature/x" },
      "only open pull requests from request-",
    ],
    ["a near-miss branch name", { headRef: "Request-7" }, "named exactly request-<number>"],
    ["a branch with a suffix", { headRef: "request-7-retry" }, "named exactly request-<number>"],
    ["a fork", { headRepo: "someone/requests" }, "from this repository"],
    ["another base", { baseRef: "develop" }, "must target main"],
    ["someone else's request branch", { author: "someone" }, "opened by the coding agent"],
    ["no configured agent", { agentLogin: "" }, "AGENT_APP_LOGIN isn't configured"],
  ])("refuses %s", (_name, overrides, problem) => {
    const result = classify({ ...agentPr, ...overrides });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.problems.join(" | ")).toContain(problem);
  });
});
