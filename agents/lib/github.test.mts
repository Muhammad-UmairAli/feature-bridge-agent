// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { GitHubApiError, createGitHubClient } from "./github.mts";

const TOKEN = "fake-github-token-for-tests";

function client(...replies: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = replies.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  });
  return { fetch, github: createGitHubClient("octo/requests", TOKEN, fetch) };
}

describe("createGitHubClient", () => {
  it("refuses a malformed repository name", () => {
    expect(() => createGitHubClient("octo/requests/../x", TOKEN)).toThrow("owner/name");
    expect(() => createGitHubClient("octo", TOKEN)).toThrow("owner/name");
  });

  it("reads an issue into a typed summary", async () => {
    const { fetch, github } = client(
      Response.json({
        number: 7,
        state: "open",
        body: null,
        user: { login: "portal[bot]", id: 1, type: "Bot" },
        labels: [{ name: "portal-request" }, "junk", null],
      }),
    );
    expect(await github.getIssue(7)).toEqual({
      number: 7,
      state: "open",
      body: "",
      user: { login: "portal[bot]", id: 1, type: "Bot" },
      labels: ["portal-request"],
      isPullRequest: false,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/octo/requests/issues/7");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init?.redirect).toBe("error");
  });

  it("pages through comments", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: "b",
      user: { login: "u", id: 2, type: "User" },
      created_at: "2026-10-08T00:00:00Z",
    }));
    const { fetch, github } = client(
      Response.json(page1),
      Response.json([{ id: 500, body: "last", user: null }, { body: "no id" }]),
    );
    const comments = await github.listComments(7);
    expect(comments).toHaveLength(101);
    expect(comments.at(-1)).toEqual({
      id: 500,
      body: "last",
      user: null,
      createdAt: "",
      updatedAt: "",
    });
    expect(String(fetch.mock.calls[1][0])).toContain("page=2");
  });

  it("posts comments and labels as JSON", async () => {
    const { fetch, github } = client(
      new Response(null, { status: 201 }),
      new Response(null, { status: 200 }),
    );
    await github.createComment(7, "hello");
    await github.addLabels(7, ["planning"]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: '{"body":"hello"}' });
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: '{"labels":["planning"]}',
    });
  });

  it("removes labels, treating an absent label as done", async () => {
    const { fetch, github } = client(
      new Response(null, { status: 200 }),
      new Response("not found", { status: 404 }),
    );
    await github.removeLabel(7, "plan ready");
    await github.removeLabel(7, "planning");
    expect(String(fetch.mock.calls[0][0])).toContain("/labels/plan%20ready");
    expect(fetch.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("reports failures by operation and status only", async () => {
    const { github } = client(
      Response.json({ message: `bad credentials ${TOKEN}` }, { status: 401 }),
    );
    const error = await github.getIssue(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(401);
    expect((error as Error).message).toBe("GitHub issues.get failed with 401");
  });

  it("retries reads and label changes once on a gateway error or network failure", async () => {
    const { fetch, github } = client(
      new Response("", { status: 503 }),
      Response.json({ number: 7, state: "open", body: "", labels: [] }),
    );
    expect((await github.getIssue(7)).state).toBe("open");
    expect(fetch).toHaveBeenCalledTimes(2);

    const network = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError(`fetch failed for ${TOKEN}`))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await createGitHubClient("octo/requests", TOKEN, network).addLabels(7, ["x"]);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("never retries posting a comment, so it can't be doubled", async () => {
    const { fetch, github } = client(new Response("", { status: 502 }));
    await expect(github.createComment(7, "hello")).rejects.toThrow("failed with 502");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports network failures as status 0 without echoing fetch's error", async () => {
    const failing = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    const error = await createGitHubClient("octo/requests", TOKEN, failing)
      .getIssue(7)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(0);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("reads an account's role, treating non-collaborators and odd names as none", async () => {
    const { fetch, github } = client(
      Response.json({ permission: "write", role_name: "triage" }),
      new Response("", { status: 404 }),
    );
    expect(await github.getRole("Lead")).toBe("triage");
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://api.github.com/repos/octo/requests/collaborators/Lead/permission",
    );
    expect(await github.getRole("stranger")).toBe("");
    expect(await github.getRole("../admin")).toBe("");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails on a role lookup the token isn't allowed to make", async () => {
    const { github } = client(new Response("", { status: 403 }));
    await expect(github.getRole("lead")).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("lists label changes by event id and finds the latest addition, across pages", async () => {
    let id = 0;
    const event = (event: string, name: string, login: string, at: string) => ({
      id: (id += 1),
      event,
      label: { name },
      actor: { login, id: 1, type: "User" },
      created_at: at,
    });
    const page1 = [
      event("labeled", "changes-requested", "first", "2026-10-01T00:00:00Z"),
      ...Array.from({ length: 98 }, () => event("labeled", "other", "x", "2026-10-02T00:00:00Z")),
      { id: 999, event: "commented", actor: null },
    ];
    const page2 = [
      event("labeled", "changes-requested", "second", "2026-10-04T00:00:00Z"),
      event("unlabeled", "changes-requested", "first", "2026-10-03T00:00:00Z"),
      { event: "labeled", label: null, actor: null },
    ];
    const { fetch, github } = client(Response.json(page1), Response.json(page2));
    const changes = await github.labelEvents(7);
    expect(changes).toHaveLength(101);
    expect(changes.map((c) => c.id)).toEqual([...changes.map((c) => c.id)].sort((a, b) => a - b));
    expect(changes.at(-1)).toMatchObject({ event: "unlabeled", label: "changes-requested" });
    expect(String(fetch.mock.calls[0][0])).toContain("/issues/7/events?per_page=100&page=1");

    const { github: again } = client(Response.json(page1), Response.json(page2));
    expect(await again.latestLabelEvent(7, "changes-requested")).toEqual({
      id: 100,
      actor: { login: "second", id: 1, type: "User" },
      createdAt: "2026-10-04T00:00:00Z",
    });
    const { github: empty } = client(Response.json([]));
    expect(await empty.latestLabelEvent(7, "changes-requested")).toBeNull();
  });
});
