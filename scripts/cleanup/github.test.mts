// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { getIssueBody, listIssuesSince, updateIssueBody } from "./github.mts";

afterEach(() => vi.unstubAllGlobals());

describe("listIssuesSince", () => {
  it("returns issues of any label across pages, skipping pull requests", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      body: `b${i}`,
      user: { login: "portal[bot]", type: "Bot" },
      labels: [{ name: "portal-request" }],
    }));
    const page2 = [
      { number: 200, body: null, user: { login: "someone", type: "User" }, labels: [] },
      { number: 201, body: "pr", pull_request: {}, user: { type: "Bot" } },
    ];
    const fetchMock = vi.fn(async (input: string) =>
      Response.json(new URL(input).searchParams.get("page") === "1" ? page1 : page2),
    );
    vi.stubGlobal("fetch", fetchMock);
    const issues = await listIssuesSince("octo/requests", "token", "2026-07-01T00:00:00.000Z");
    expect(issues).toHaveLength(101);
    expect(issues[0]).toEqual({
      number: 1,
      body: "b0",
      authorLogin: "portal[bot]",
      authorType: "Bot",
      labels: ["portal-request"],
    });
    expect(issues.at(-1)).toMatchObject({ number: 200, body: "", authorType: "User", labels: [] });
    const query = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(query.get("since")).toBe("2026-07-01T00:00:00.000Z");
    expect(query.get("state")).toBe("all");
    expect(query.has("labels")).toBe(false);
  });

  it("fails loudly on errors or unexpected replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await expect(listIssuesSince("octo/requests", "token", "x")).rejects.toThrow(/500/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "x" })),
    );
    await expect(listIssuesSince("octo/requests", "token", "x")).rejects.toThrow(/non-list/);
  });
});

describe("issue bodies", () => {
  it("reads and PATCHes a single issue's body", async () => {
    const fetchMock = vi.fn(async (_input: string, init: RequestInit = {}) =>
      Response.json(init.method === "PATCH" ? {} : { body: "current" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await getIssueBody("octo/requests", "token", 7)).toBe("current");
    await updateIssueBody("octo/requests", "token", 7, "new body");
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octo/requests/issues/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ body: "new body" });
    expect(init.redirect).toBe("error");
  });
});
