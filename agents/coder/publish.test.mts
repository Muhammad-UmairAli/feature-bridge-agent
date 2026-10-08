// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { GitHubApiError } from "../lib/github.mts";
import {
  PublishIncomplete,
  PublishRefused,
  commitMessage,
  publishDemo,
  publishProblems,
  pullBody,
} from "./publish.mts";
import { loaderTemplate, pageTemplate } from "./template.mts";

const SLUG = "request-7";
const dir = `src/app/demos/${SLUG}/`;
const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const NEW_TREE = "c".repeat(40);
const COMMIT = "d".repeat(40);
const demo = '"use client";\n\nexport default function Demo() {\n  return <p>Hi</p>;\n}\n';
const test =
  'import { render } from "@testing-library/react";\nimport { it } from "vitest";\n\nimport Demo from "./demo";\n\nit("renders", () => {\n  render(<Demo />);\n});\n';
const files = [
  { path: `${dir}page.tsx`, content: pageTemplate("Counter") },
  { path: `${dir}demo-loader.tsx`, content: loaderTemplate() },
  { path: `${dir}demo.tsx`, content: demo },
  { path: `${dir}demo.test.tsx`, content: test },
];
const input = { repo: "octo/requests", issueNumber: 7, slug: SLUG, files };
const PULL_LIST = `GET /pulls?state=all&head=octo:${SLUG}&per_page=1`;

/**
 * A fake GitHub that records calls and answers the happy path unless told
 * otherwise. Overrides are factories (a fresh Response per call); a list is
 * used in order, its last entry repeating.
 */
type Reply = () => Response;
function github(overrides: Record<string, Reply | Reply[]> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const queues = Object.fromEntries(
    Object.entries(overrides).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).replace("https://api.github.com/repos/octo/requests", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    const queued = queues[key];
    if (queued?.length) return (queued.length > 1 ? (queued.shift() as Reply) : queued[0])();
    if (key === `GET /git/ref/heads/${SLUG}`) return new Response("", { status: 404 });
    if (key === PULL_LIST) return Response.json([]);
    if (key === "GET /git/ref/heads/main") return Response.json({ object: { sha: BASE } });
    if (key.startsWith(`GET /contents/src/app/demos/${SLUG}`))
      return new Response("", { status: 404 });
    if (key === `GET /git/commits/${BASE}`) return Response.json({ tree: { sha: TREE } });
    if (key === "POST /git/trees") return Response.json({ sha: NEW_TREE });
    if (key === "POST /git/commits") return Response.json({ sha: COMMIT });
    if (key === "POST /git/refs") return Response.json({ ref: `refs/heads/${SLUG}` });
    if (key === "POST /pulls")
      return Response.json({ number: 12, html_url: "https://github.test/pull/12" });
    return new Response("", { status: 500 });
  });
  return { fetchMock, calls };
}

const published = {
  branch: SLUG,
  commitSha: COMMIT,
  pullNumber: 12,
  pullUrl: "https://github.test/pull/12",
};

describe("publishProblems", () => {
  it("accepts the generated set and refuses anything that drifted from it", () => {
    expect(publishProblems(input)).toEqual([]);
    expect(publishProblems({ ...input, issueNumber: 0, slug: "request-0" })).toEqual([
      "invalid repository or request number",
    ]);
    expect(publishProblems({ ...input, repo: "a/b/c" })).toEqual([
      "invalid repository or request number",
    ]);
    expect(publishProblems({ ...input, slug: "request-8" })).toEqual([
      "the demo folder doesn't match the request",
    ]);
    const page = files.map((f) =>
      f.path.endsWith("page.tsx") ? { ...f, content: `${f.content}// x\n` } : f,
    );
    expect(publishProblems({ ...input, files: page })).toContain(
      "the page isn't the workflow's template",
    );
    const loader = files.filter((f) => !f.path.endsWith("demo-loader.tsx"));
    expect(publishProblems({ ...input, files: loader })).toContain(
      "the loader isn't the workflow's template",
    );
    const extra = [...files, { path: ".github/workflows/x.yml", content: "x" }];
    expect(publishProblems({ ...input, files: extra }).join(" | ")).toContain(
      "not an allowed file",
    );
    const bad = files.map((f) =>
      f.path.endsWith("/demo.tsx") ? { ...f, content: `${demo}fetch("/x");\n` } : f,
    );
    expect(publishProblems({ ...input, files: bad }).join(" | ")).toContain("makes network calls");
  });
});

describe("publishDemo", () => {
  it("commits exactly the files on request-<n> from main and opens a pull request with fixed text", async () => {
    const gh = github();
    expect(await publishDemo("fake-token", input, gh.fetchMock)).toEqual(published);
    const body = (method: string, path: string) =>
      gh.calls.find((call) => call.method === method && call.path === path)?.body;
    expect(body("POST", "/git/trees")).toEqual({
      base_tree: TREE,
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    });
    expect(body("POST", "/git/commits")).toEqual({
      message: commitMessage(7),
      tree: NEW_TREE,
      parents: [BASE],
    });
    expect(body("POST", "/git/refs")).toEqual({ ref: `refs/heads/${SLUG}`, sha: COMMIT });
    expect(body("POST", "/pulls")).toEqual({
      title: "Demo for request #7",
      head: SLUG,
      base: "main",
      body: pullBody(7, SLUG),
      maintainer_can_modify: false,
    });
    const headers = gh.fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-token");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(commitMessage(7)).toMatch(/^feat\(demos\): build request #7\n/);
  });

  it.each([
    [
      "the branch exists",
      { [`GET /git/ref/heads/${SLUG}`]: () => Response.json({ object: { sha: BASE } }) },
      "branch_exists",
    ],
    [
      "a pull request exists",
      { [PULL_LIST]: () => Response.json([{ number: 3, html_url: "u" }]) },
      "pull_exists",
    ],
    [
      "the demo folder exists on main",
      { [`GET /contents/src/app/demos/${SLUG}?ref=${BASE}`]: () => Response.json([]) },
      "folder_exists",
    ],
  ])("refuses when %s, before writing anything", async (_name, overrides, reason) => {
    const gh = github(overrides);
    const error = await publishDemo("fake-token", input, gh.fetchMock).catch((e: unknown) => e);
    expect((error as PublishRefused).reason).toBe(reason);
    expect(gh.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses invalid files without any call", async () => {
    const gh = github();
    const error = await publishDemo("fake-token", { ...input, files: [] }, gh.fetchMock).catch(
      (e: unknown) => e,
    );
    expect((error as PublishRefused).reason).toBe("invalid_files");
    expect(gh.calls).toHaveLength(0);
  });

  it("treats a failed branch lookup as an error, not as 'no branch'", async () => {
    const gh = github({ [`GET /git/ref/heads/${SLUG}`]: () => new Response("", { status: 403 }) });
    const error = await publishDemo("fake-token", input, gh.fetchMock).catch((e: unknown) => e);
    expect((error as GitHubApiError).message).toBe("GitHub git.getBranchRef failed with 403");
  });

  it("carries on when the branch points at this commit after a lost createRef response", async () => {
    const gh = github({
      "POST /git/refs": () => new Response("", { status: 502 }),
      [`GET /git/ref/heads/${SLUG}`]: [
        () => new Response("", { status: 404 }),
        () => Response.json({ object: { sha: COMMIT } }),
      ],
    });
    expect(await publishDemo("fake-token", input, gh.fetchMock)).toEqual(published);
  });

  it("stops when another run created the branch first", async () => {
    const gh = github({
      "POST /git/refs": () => new Response("", { status: 422 }),
      [`GET /git/ref/heads/${SLUG}`]: [
        () => new Response("", { status: 404 }),
        () => Response.json({ object: { sha: BASE } }),
      ],
    });
    const error = await publishDemo("fake-token", input, gh.fetchMock).catch((e: unknown) => e);
    expect((error as PublishRefused).reason).toBe("branch_exists");
    expect(gh.calls.some((call) => call.path === "/pulls" && call.method === "POST")).toBe(false);
  });

  it("finds a pull request whose creation response was lost", async () => {
    const gh = github({
      "POST /pulls": () => new Response("", { status: 502 }),
      [PULL_LIST]: [
        () => Response.json([]),
        () => Response.json([{ number: 12, html_url: "https://github.test/pull/12" }]),
      ],
    });
    expect(await publishDemo("fake-token", input, gh.fetchMock)).toEqual(published);
  });

  it("hands over, without deleting anything, when the pull request couldn't be opened", async () => {
    const gh = github({ "POST /pulls": () => new Response("", { status: 403 }) });
    const error = await publishDemo("fake-token", input, gh.fetchMock).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishIncomplete);
    expect((error as PublishIncomplete).branch).toBe(SLUG);
    expect(gh.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("reports other GitHub failures by operation and status", async () => {
    const gh = github({ "POST /git/commits": () => new Response("", { status: 422 }) });
    const error = await publishDemo("fake-token", input, gh.fetchMock).catch((e: unknown) => e);
    expect((error as GitHubApiError).message).toBe("GitHub git.createCommit failed with 422");
  });
});
