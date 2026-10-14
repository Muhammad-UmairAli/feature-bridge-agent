// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loaderTemplate, pageTemplate } from "../coder/template.mts";

import { checkPullRequest, createGit } from "./pull-request.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const pr = {
  headRef: SLUG,
  headRepo: "octo/requests",
  baseRepo: "octo/requests",
  baseRef: "main",
  author: "request-coder[bot]",
  agentLogin: "request-coder[bot]",
};

let repo = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: repo,
      NODE_ENV: "test",
    },
  }).trim();
const write = (path: string, content = "export {};\n") => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
};
/** The workflow's page and loader plus a demo component. */
const writeDemo = () => {
  write(`${dir}page.tsx`, pageTemplate("Counter"));
  write(`${dir}demo-loader.tsx`, loaderTemplate());
  write(`${dir}demo.tsx`, '"use client";\n\nexport default function Demo() {\n  return null;\n}\n');
};
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
};
const check = (base: string, head: string, info = pr) =>
  checkPullRequest(info, base, head, createGit(repo));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "write-scope-"));
  git("init", "-q", "-b", "main");
  write("README.md", "base\n");
  commit("base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("checkPullRequest", () => {
  it("passes a clean request branch, including empty commits", async () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", SLUG);
    writeDemo();
    commit("add demo");
    write(`${dir}counter.tsx`);
    commit("add counter");
    const head = commit("empty");
    expect(await check(base, head)).toEqual({ skipped: false, checked: 4, problems: [] });
  });

  it("skips pull requests that aren't request branches", async () => {
    const base = git("rev-parse", "HEAD");
    write("src/app/page.tsx");
    const head = commit("portal change");
    expect(await check(base, head, { ...pr, headRef: "feature/x", author: "someone" })).toEqual({
      skipped: true,
      checked: 0,
      problems: [],
    });
  });

  it("lists exactly what's wrong with a sneaky branch", async () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", SLUG);
    writeDemo();
    write(`${dir}helper.ts`);
    commit("add demo");
    git("mv", `${dir}helper.ts`, "src/app/helper.ts"); // a rename out of the folder
    symlinkSync("../../../README.md", join(repo, `${dir}link.ts`));
    chmodSync(join(repo, `${dir}page.tsx`), 0o755);
    write(`${dir}evil.ts`, "/* eslint-disable */\nexport const x = fetch;\n");
    const head = commit("sneaky");

    const { problems } = await check(base, head);
    expect([...problems].sort()).toEqual(
      [
        `"${dir}page.tsx": only regular files are allowed (mode 100644 -> 100755)`,
        `"src/app/helper.ts": outside src/app/demos/${SLUG}/ or not an allowed demo file`,
        `"${dir}link.ts": only regular files are allowed (mode 000000 -> 120000)`,
        `"${dir}evil.ts": contains a lint or type-check suppression`,
      ].sort(),
    );
  });

  it("counts identical files toward the total size", async () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", SLUG);
    writeDemo();
    const big = `export const data = "${"x".repeat(90_000)}";\n`;
    for (let i = 0; i < 12; i += 1) write(`${dir}copy-${i}.ts`, big);
    const head = commit("many copies");
    expect((await check(base, head)).problems).toEqual([
      "the pull request adds more than 1000000 bytes of files",
    ]);
  });

  it("refuses a branch that leaves no demo page at the head", async () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", SLUG);
    writeDemo();
    commit("add demo");
    git("rm", "-q", `${dir}page.tsx`);
    const head = commit("remove it again");
    expect((await check(base, head)).problems).toEqual([
      `src/app/demos/${SLUG}/page.tsx is missing at the head`,
    ]);
  });

  it("refuses merge commits", async () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", SLUG);
    write(`${dir}page.tsx`);
    commit("add page");
    git("checkout", "-q", "main");
    write("other.md");
    commit("other");
    git("checkout", "-q", SLUG);
    git("merge", "-q", "--no-edit", "main");
    const head = git("rev-parse", "HEAD");
    const { problems } = await check(base, head);
    expect(problems[0]).toMatch(/^merge commits aren't allowed on request branches: [0-9a-f]{40}$/);
  });

  it("refuses changing a demo that already exists on the base branch", async () => {
    writeDemo();
    const base = commit("live demo");
    git("checkout", "-q", "-b", SLUG);
    write(
      `${dir}demo.tsx`,
      '"use client";\n\nexport default function Demo() {\n  return "changed";\n}\n',
    );
    const head = commit("change live demo");
    expect((await check(base, head)).problems).toEqual([
      `src/app/demos/${SLUG}/ already exists on the base branch`,
    ]);
  });

  it("refuses request branches from anyone but the agent, without reading commits", async () => {
    const base = git("rev-parse", "HEAD");
    expect(await check(base, base, { ...pr, author: "someone" })).toEqual({
      skipped: false,
      checked: 0,
      problems: ["request pull requests must be opened by the coding agent"],
    });
  });

  it("refuses ids that aren't full commit ids, and fails on unknown commits", async () => {
    expect((await check("abc", "def")).problems).toEqual([
      "the base and head must be full commit ids",
    ]);
    const base = git("rev-parse", "HEAD");
    await expect(check(base, "f".repeat(40))).rejects.toThrow();
  });

  it("refuses a page or loader that differs from the workflow's templates", async () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", SLUG);
    writeDemo();
    write(
      `${dir}page.tsx`,
      pageTemplate("Counter").replace("<DemoLoader />", "<DemoLoader />{process.env.X}"),
    );
    write(`${dir}demo-loader.tsx`, `${loaderTemplate()}export const x = 1;\n`);
    const head = commit("tamper");
    expect((await check(base, head)).problems).toEqual([
      `src/app/demos/${SLUG}/page.tsx doesn't match the workflow's page template`,
      `src/app/demos/${SLUG}/demo-loader.tsx doesn't match the workflow's loader template`,
    ]);
  });
});
