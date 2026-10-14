// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { AGENT_ID, AGENT_LOGIN } from "../planner/planner.mts";
import { reviewMarker } from "../reviewer/review.mts";
import { type CollectOptions, collectFacts } from "./collect.mts";

const REPO = "octo/requests";
const PORTAL = "portal[bot]";
const APP = "coder-app[bot]";
const TOKEN = "fake-github-token-for-tests";
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);

/** What a preview deployment made by the hosting integration looks like. */
const PREVIEW = { creator: { type: "Bot" }, production_environment: false };

const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  created_at: "2026-10-10T10:00:00Z",
  user: { login: PORTAL, type: "Bot" },
  ...extra,
});
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number: 100 + number,
  created_at: "2026-10-10T10:05:00Z",
  user: { login: APP, type: "Bot" },
  head: { ref: `request-${number}`, repo: { full_name: REPO } },
  ...extra,
});

type Routes = Record<string, unknown>;

/** Replies for one request (number 1, pull 101) with everything present. */
function happyRoutes(): Routes {
  return {
    "/issues": [issue(1)],
    "/pulls": [pull(1)],
    "/pulls/101/commits": [
      { sha: FIRST, author: { login: APP } },
      { sha: SECOND, author: { login: "maintainer" } },
    ],
    "/issues/1/events": [
      {
        event: "labeled",
        label: { name: "approved-by-human" },
        created_at: "2026-10-10T10:02:00Z",
      },
      { event: "labeled", label: { name: "plan-ready" }, created_at: "2026-10-10T10:01:00Z" },
    ],
    // Found by commit, as the hosting integration records the commit as the ref.
    "/deployments": (query: URLSearchParams) =>
      query.get("sha") === FIRST
        ? [{ id: 9, sha: FIRST, created_at: "2026-10-10T10:06:00Z", ...PREVIEW }]
        : [{ id: 10, sha: SECOND, created_at: "2026-10-10T10:20:00Z", ...PREVIEW }],
    "/deployments/9/statuses": [
      { state: "success", created_at: "2026-10-10T10:09:00Z" },
      { state: "in_progress", created_at: "2026-10-10T10:07:00Z" },
    ],
    "/deployments/10/statuses": [{ state: "success", created_at: "2026-10-10T10:22:00Z" }],
    "/actions/runs": {
      workflow_runs: [
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          created_at: "2026-10-10T10:06:00Z",
          head_repository: { full_name: REPO },
        },
      ],
    },
    "/issues/101/comments": [
      {
        id: 5,
        body: `${reviewMarker("pass", FIRST)}\nAll good`,
        user: { login: AGENT_LOGIN, id: AGENT_ID },
        created_at: "2026-10-10T10:08:00Z",
        updated_at: "2026-10-10T10:08:00Z",
      },
    ],
  };
}

function setup(routes: Routes, overrides: Partial<CollectOptions> = {}) {
  const calls: { method: string; path: string; query: URLSearchParams; auth: string }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(`/repos/${REPO}`, "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      query: url.searchParams,
      auth: String((init?.headers as Record<string, string>)?.Authorization),
    });
    const raw = routes[path];
    const reply =
      typeof raw === "function"
        ? (raw as (query: URLSearchParams) => unknown)(url.searchParams)
        : raw;
    if (reply instanceof Response) return reply;
    return Response.json(reply ?? []);
  });
  const options: CollectOptions = {
    repo: REPO,
    token: TOKEN,
    portalBotLogin: PORTAL,
    agentAppLogin: APP,
    days: 90,
    maxRequests: 100,
    callBudget: 500,
    now: new Date("2026-10-14T00:00:00Z"),
    fetchImpl: fetch,
    sleep: async () => {},
    ...overrides,
  };
  return { calls, run: () => collectFacts(options) };
}

describe("collectFacts", () => {
  it("reads one request's facts from GitHub", async () => {
    const { run } = setup(happyRoutes());
    expect(await run()).toEqual({
      requests: [
        {
          number: 1,
          createdAt: "2026-10-10T10:00:00Z",
          approvedAt: "2026-10-10T10:02:00Z",
          hasPull: true,
          previewReadyAt: "2026-10-10T10:09:00Z",
          previewSha: FIRST,
          commits: [
            { sha: FIRST, authorLogin: APP },
            { sha: SECOND, authorLogin: "maintainer" },
          ],
          firstCi: "success",
          firstReview: "pass",
        },
      ],
      unreadable: 0,
      tooBusy: 0,
      stoppedEarly: false,
      truncated: false,
    });
  });

  it("only reads, and sends the token only as the authorization header", async () => {
    const { calls, run } = setup(happyRoutes());
    await run();
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.some((call) => call.query.toString().includes(TOKEN))).toBe(false);
  });

  it("keeps only issues created by the portal bot, inside the window, that are not pull requests", async () => {
    const routes = happyRoutes();
    routes["/issues"] = [
      issue(1),
      issue(2, { user: { login: "someone", type: "User" } }),
      issue(3, { user: { login: "other[bot]", type: "Bot" } }),
      issue(4, { pull_request: {} }),
      issue(5, { created_at: "2026-05-01T00:00:00Z" }),
    ];
    const { run } = setup(routes);
    const result = await run();
    expect(result.requests.map((request) => request.number)).toEqual([1]);
  });

  it("stops at the request limit", async () => {
    const routes = happyRoutes();
    routes["/issues"] = [issue(1), issue(2), issue(3)];
    const { run } = setup(routes, { maxRequests: 2 });
    const result = await run();
    expect(result.requests).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("records a request with no agent pull request and reads nothing more for it", async () => {
    const routes = happyRoutes();
    routes["/pulls"] = [];
    const { calls, run } = setup(routes);
    const result = await run();
    expect(result.requests).toEqual([
      expect.objectContaining({
        number: 1,
        hasPull: false,
        approvedAt: null,
        previewReadyAt: null,
        commits: [],
        firstCi: "none",
        firstReview: "none",
      }),
    ]);
    expect(calls.map((call) => call.path)).toEqual(["/issues", "/pulls"]);
  });

  it("ignores a pull request from a fork or by someone other than the coding agent", async () => {
    const routes = happyRoutes();
    routes["/pulls"] = [
      pull(1, { head: { ref: "request-1", repo: { full_name: "attacker/requests" } } }),
      pull(1, { user: { login: "someone", type: "User" } }),
    ];
    const { run } = setup(routes);
    expect((await run()).requests[0].hasPull).toBe(false);
  });

  describe("preview", () => {
    it("takes the oldest deployment's success, and the commit it was built from", async () => {
      const routes = happyRoutes();
      routes["/deployments"] = (query: URLSearchParams) =>
        query.get("sha") === FIRST
          ? [
              { id: 12, sha: FIRST, created_at: "2026-10-10T10:08:00Z", ...PREVIEW },
              { id: 9, sha: FIRST, created_at: "2026-10-10T10:06:00Z", ...PREVIEW },
            ]
          : [];
      routes["/deployments/12/statuses"] = [
        { state: "success", created_at: "2026-10-10T10:30:00Z" },
      ];
      const { run } = setup(routes);
      const [request] = (await run()).requests;
      expect(request.previewReadyAt).toBe("2026-10-10T10:09:00Z");
      expect(request.previewSha).toBe(FIRST);
    });

    it("ignores a deployment of a different commit than the one asked for", async () => {
      const routes = happyRoutes();
      routes["/deployments"] = () => [
        { id: 11, sha: "9".repeat(40), created_at: "2026-10-10T10:01:00Z", ...PREVIEW },
      ];
      routes["/deployments/11/statuses"] = [
        { state: "success", created_at: "2026-10-10T10:02:00Z" },
      ];
      const { run } = setup(routes);
      const [request] = (await run()).requests;
      expect(request.previewReadyAt).toBeNull();
      expect(request.previewSha).toBeNull();
    });

    it("has no preview while no deployment succeeded", async () => {
      const routes = happyRoutes();
      routes["/deployments/9/statuses"] = [
        { state: "failure", created_at: "2026-10-10T10:09:00Z" },
      ];
      routes["/deployments/10/statuses"] = [
        { state: "pending", created_at: "2026-10-10T10:22:00Z" },
      ];
      const { run } = setup(routes);
      expect((await run()).requests[0].previewReadyAt).toBeNull();
    });
  });

  describe("CI result of the first commit", () => {
    const withRuns = (runs: unknown[]) => {
      const routes = happyRoutes();
      routes["/actions/runs"] = { workflow_runs: runs };
      return setup(routes);
    };
    const ci = (extra: Record<string, unknown>) => ({
      name: "CI",
      status: "completed",
      conclusion: "success",
      created_at: "2026-10-10T10:06:00Z",
      head_repository: { full_name: REPO },
      ...extra,
    });

    it("uses the newest CI run, so a re-run that passed counts", async () => {
      const { run } = withRuns([
        ci({ conclusion: "failure", created_at: "2026-10-10T10:06:00Z" }),
        ci({ conclusion: "success", created_at: "2026-10-10T10:12:00Z" }),
      ]);
      expect((await run()).requests[0].firstCi).toBe("success");
    });

    it("maps the other outcomes", async () => {
      expect((await withRuns([ci({ conclusion: "failure" })]).run()).requests[0].firstCi).toBe(
        "failure",
      );
      expect(
        (await withRuns([ci({ status: "in_progress", conclusion: null })]).run()).requests[0]
          .firstCi,
      ).toBe("pending");
      expect((await withRuns([ci({ conclusion: "cancelled" })]).run()).requests[0].firstCi).toBe(
        "none",
      );
      expect((await withRuns([]).run()).requests[0].firstCi).toBe("none");
    });

    it("ignores other workflows and runs from other repositories", async () => {
      const { run } = withRuns([
        ci({ name: "Write scope", conclusion: "failure" }),
        ci({ conclusion: "failure", head_repository: { full_name: "attacker/requests" } }),
      ]);
      expect((await run()).requests[0].firstCi).toBe("none");
    });

    it("asks for the first commit's runs", async () => {
      const { calls, run } = withRuns([]);
      await run();
      const runs = calls.find((call) => call.path === "/actions/runs");
      expect(runs?.query.get("head_sha")).toBe(FIRST);
    });
  });

  describe("automated review result of the first commit", () => {
    const comment = (
      id: number,
      body: string,
      user = { login: AGENT_LOGIN, id: AGENT_ID },
      at = "2026-10-10T10:08:00Z",
    ) => ({
      id,
      body,
      user,
      created_at: at,
      updated_at: at,
    });

    it("uses the latest verdict for the first commit only", async () => {
      const routes = happyRoutes();
      routes["/issues/101/comments"] = [
        comment(1, reviewMarker("findings", FIRST), undefined, "2026-10-10T10:08:00Z"),
        comment(2, reviewMarker("pass", FIRST), undefined, "2026-10-10T10:30:00Z"),
        comment(3, reviewMarker("error", SECOND), undefined, "2026-10-10T10:40:00Z"),
      ];
      const { run } = setup(routes);
      expect((await run()).requests[0].firstReview).toBe("pass");
    });

    it("ignores a verdict written by anyone but the workflow bot", async () => {
      const routes = happyRoutes();
      routes["/issues/101/comments"] = [
        comment(1, reviewMarker("pass", FIRST), { login: "someone", id: 7 }),
        comment(2, reviewMarker("pass", FIRST), { login: AGENT_LOGIN, id: 7 }),
      ];
      const { run } = setup(routes);
      expect((await run()).requests[0].firstReview).toBe("none");
    });

    it("reports none when the first commit has not been reviewed", async () => {
      const routes = happyRoutes();
      routes["/issues/101/comments"] = [comment(1, reviewMarker("pass", SECOND))];
      const { run } = setup(routes);
      expect((await run()).requests[0].firstReview).toBe("none");
    });
  });

  it("uses the last approval made before the pull request opened", async () => {
    const routes = happyRoutes();
    routes["/issues/1/events"] = [
      {
        event: "labeled",
        label: { name: "approved-by-human" },
        created_at: "2026-10-10T10:01:00Z",
      },
      {
        event: "unlabeled",
        label: { name: "approved-by-human" },
        created_at: "2026-10-10T10:02:00Z",
      },
      {
        event: "labeled",
        label: { name: "approved-by-human" },
        created_at: "2026-10-10T10:03:00Z",
      },
      {
        event: "labeled",
        label: { name: "approved-by-human" },
        created_at: "2026-10-10T11:00:00Z",
      },
    ];
    const { run } = setup(routes);
    expect((await run()).requests[0].approvedAt).toBe("2026-10-10T10:03:00Z");
  });

  describe("failures", () => {
    it("leaves out a request that can't be read and carries on with the others", async () => {
      const routes = happyRoutes();
      routes["/issues"] = [issue(1), issue(2)];
      routes["/pulls"] = [pull(1), pull(2)];
      routes["/pulls/101/commits"] = new Response("boom", { status: 500 });
      routes["/pulls/102/commits"] = [{ sha: FIRST, author: { login: APP } }];
      const result = await setup(routes).run();
      expect(result.unreadable).toBe(1);
      expect(result.requests.map((request) => request.number)).toEqual([2]);
    });

    it("stops the whole run on an authorization or rate limit error", async () => {
      for (const status of [401, 403, 429]) {
        const routes = happyRoutes();
        routes["/pulls"] = new Response("no", { status });
        await expect(setup(routes).run()).rejects.toThrow(`failed with ${status}`);
      }
    });

    it("fails when the list of issues can't be read at all", async () => {
      const routes = happyRoutes();
      routes["/issues"] = new Response("down", { status: 500 });
      await expect(setup(routes).run()).rejects.toThrow("failed with 500");
    });

    it("never puts response text or the token in an error", async () => {
      const failure = async (reply: Response) => {
        const routes = happyRoutes();
        routes["/issues"] = reply;
        let message = "";
        await setup(routes)
          .run()
          .then(
            () => {
              throw new Error("expected a failure");
            },
            (caught: unknown) => {
              message = caught instanceof Error ? caught.message : "";
            },
          );
        return message;
      };
      // An error status, and a success whose body isn't JSON (a parse error can quote the body).
      expect(await failure(new Response(`secret ${TOKEN}`, { status: 500 }))).toBe(
        "GitHub issues.list failed with 500",
      );
      expect(await failure(new Response(`secret ${TOKEN}`, { status: 200 }))).toBe(
        "GitHub issues.list failed with 0",
      );
    });

    it("stops early when the call budget runs out, keeping what was read", async () => {
      const routes = happyRoutes();
      routes["/issues"] = [issue(1), issue(2), issue(3)];
      routes["/pulls"] = [pull(1), pull(2), pull(3)];
      // Every request has commits, so each one costs a full read (about seven calls).
      routes["/pulls/102/commits"] = routes["/pulls/101/commits"];
      routes["/pulls/103/commits"] = routes["/pulls/101/commits"];
      const { calls, run } = setup(routes, { callBudget: 12 });
      const result = await run();
      expect(result.stoppedEarly).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(12);
      expect(result.requests.map((request) => request.number)).toEqual([1]);
    });
  });
});

describe("collectFacts: limits, retries and unusual data", () => {
  const issuesPage = (start: number, count: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_, index) => issue(start + index, extra));
  const OLD = "2026-05-01T00:00:00Z";

  it("is not truncated when the request count equals the limit", async () => {
    const routes = happyRoutes();
    routes["/issues"] = [issue(1), issue(2)];
    const result = await setup(routes, { maxRequests: 2 }).run();
    expect(result.requests).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("pages through the issues, asking for the labelled issues newest first", async () => {
    const queries: URLSearchParams[] = [];
    const routes: Routes = {
      "/issues": (query: URLSearchParams) => {
        queries.push(query);
        return query.get("page") === "1" ? issuesPage(1, 100) : issuesPage(101, 1);
      },
      "/pulls": [],
    };
    const result = await setup(routes, { maxRequests: 500, callBudget: 1000 }).run();
    expect(result.requests).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(queries.map((query) => query.get("page"))).toEqual(["1", "2"]);
    expect(Object.fromEntries(queries[0])).toMatchObject({
      labels: "portal-request",
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: "100",
    });
  });

  it("stops paging at the first issue older than the window, even in the middle of a page", async () => {
    const pages: string[] = [];
    const routes: Routes = {
      "/issues": (query: URLSearchParams) => {
        pages.push(query.get("page") ?? "");
        return query.get("page") === "1"
          ? issuesPage(1, 100)
          : [...issuesPage(101, 10), ...issuesPage(111, 90, { created_at: OLD })];
      },
      "/pulls": [],
    };
    const result = await setup(routes, { maxRequests: 500, callBudget: 1000 }).run();
    expect(result.requests).toHaveLength(110);
    expect(result.truncated).toBe(false);
    expect(pages).toEqual(["1", "2"]);
  });

  it("reports truncation when every page is full and none reaches the start of the window", async () => {
    const routes: Routes = {
      "/issues": (query: URLSearchParams) => issuesPage(Number(query.get("page")) * 1000, 100),
      "/pulls": [],
    };
    const result = await setup(routes, { maxRequests: 5000, callBudget: 5000 }).run();
    expect(result.requests).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  describe("retries", () => {
    it("retries once after a 502, waiting first, and counts every attempt", async () => {
      let attempts = 0;
      const routes = happyRoutes();
      routes["/issues"] = () => {
        attempts += 1;
        return attempts === 1 ? new Response("bad gateway", { status: 502 }) : [issue(1)];
      };
      const sleep = vi.fn(async () => {});
      const { calls, run } = setup(routes, { sleep });
      expect((await run()).requests).toHaveLength(1);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(1500);
      expect(calls.filter((call) => call.path === "/issues")).toHaveLength(2);
    });

    it("retries once after a network error", async () => {
      let attempts = 0;
      const routes = happyRoutes();
      routes["/issues"] = () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError(`fetch failed for ${TOKEN}`);
        return [issue(1)];
      };
      expect((await setup(routes).run()).requests).toHaveLength(1);
    });

    it("gives up after a second failure, without echoing the network error", async () => {
      const failing = async (routes: Routes) => {
        let message = "";
        await setup(routes)
          .run()
          .then(
            () => {
              throw new Error("expected a failure");
            },
            (caught: unknown) => {
              message = caught instanceof Error ? caught.message : "";
            },
          );
        return message;
      };
      const unavailable = happyRoutes();
      unavailable["/issues"] = () => new Response("down", { status: 503 });
      expect(await failing(unavailable)).toBe("GitHub issues.list failed with 503");

      const offline = happyRoutes();
      offline["/issues"] = () => {
        throw new TypeError(`fetch failed for ${TOKEN}`);
      };
      expect(await failing(offline)).toBe("GitHub issues.list failed with 0");
    });

    it("counts a retry against the call budget", async () => {
      let attempts = 0;
      const routes = happyRoutes();
      routes["/issues"] = () => {
        attempts += 1;
        return attempts === 1 ? new Response("bad gateway", { status: 502 }) : [issue(1)];
      };
      const { calls, run } = setup(routes, { callBudget: 2 });
      const result = await run();
      expect(calls).toHaveLength(2);
      expect(result.stoppedEarly).toBe(true);
      expect(result.requests).toEqual([]);
    });
  });

  it("leaves out a request whose replies are malformed instead of treating them as empty", async () => {
    const brokenPulls = happyRoutes();
    brokenPulls["/pulls"] = {};
    expect(await setup(brokenPulls).run()).toMatchObject({ unreadable: 1, requests: [] });

    const brokenRuns = happyRoutes();
    brokenRuns["/actions/runs"] = [];
    expect(await setup(brokenRuns).run()).toMatchObject({ unreadable: 1, requests: [] });
  });

  it("reports a request with too many comments rather than dropping it silently", async () => {
    const routes = happyRoutes();
    routes["/issues/101/comments"] = () => Array.from({ length: 100 }, (_, id) => ({ id }));
    expect(await setup(routes).run()).toMatchObject({ tooBusy: 1, unreadable: 0, requests: [] });
  });

  it("reports a request with too many events rather than shrinking one sample", async () => {
    const routes = happyRoutes();
    routes["/issues/1/events"] = () =>
      Array.from({ length: 100 }, () => ({
        event: "labeled",
        label: { name: "other" },
        created_at: "2026-10-10T10:01:00Z",
      }));
    expect(await setup(routes).run()).toMatchObject({ tooBusy: 1, unreadable: 0, requests: [] });
  });

  describe("previews", () => {
    it("finds deployments by commit, never by branch name", async () => {
      const { calls, run } = setup(happyRoutes());
      await run();
      const lookups = calls.filter((call) => call.path === "/deployments");
      expect(lookups.length).toBeGreaterThan(0);
      for (const lookup of lookups) {
        expect(lookup.query.get("sha")).toMatch(/^[0-9a-f]{40}$/);
        expect(lookup.query.has("ref")).toBe(false);
      }
    });

    it("takes the first successful preview from a later commit when the first never had one", async () => {
      const routes = happyRoutes();
      routes["/deployments"] = (query: URLSearchParams) =>
        query.get("sha") === SECOND
          ? [{ id: 10, sha: SECOND, created_at: "2026-10-10T10:20:00Z", ...PREVIEW }]
          : [];
      routes["/deployments/10/statuses"] = [
        { state: "success", created_at: "2026-10-10T10:22:00Z" },
      ];
      const [request] = (await setup(routes).run()).requests;
      expect(request.previewSha).toBe(SECOND);
      expect(request.previewReadyAt).toBe("2026-10-10T10:22:00Z");
    });

    it("looks past failed deployments and stops at the first one with a success", async () => {
      const routes = happyRoutes();
      const stamp = (minute: number) => `2026-10-10T10:${String(minute).padStart(2, "0")}:00Z`;
      routes["/deployments"] = Array.from({ length: 7 }, (_, index) => ({
        id: 20 + index,
        sha: FIRST,
        created_at: stamp(index + 1),
        ...PREVIEW,
      }));
      for (let id = 20; id <= 24; id += 1) {
        routes[`/deployments/${id}/statuses`] = [{ state: "failure", created_at: stamp(30) }];
      }
      routes["/deployments/25/statuses"] = [{ state: "success", created_at: stamp(40) }];
      const { calls, run } = setup(routes);
      const [request] = (await run()).requests;
      expect(request.previewReadyAt).toBe(stamp(40));
      expect(calls.some((call) => call.path === "/deployments/26/statuses")).toBe(false);
    });

    it("ignores deployments that were not made by a bot or were made to production", async () => {
      const routes = happyRoutes();
      routes["/deployments"] = [
        { id: 30, sha: FIRST, created_at: "2026-10-10T10:00:00Z", creator: { type: "User" } },
        {
          id: 31,
          sha: FIRST,
          created_at: "2026-10-10T10:01:00Z",
          creator: { type: "Bot" },
          production_environment: true,
        },
      ];
      routes["/deployments/30/statuses"] = [
        { state: "success", created_at: "2026-10-10T10:02:00Z" },
      ];
      routes["/deployments/31/statuses"] = [
        { state: "success", created_at: "2026-10-10T10:03:00Z" },
      ];
      const [request] = (await setup(routes).run()).requests;
      expect(request.previewReadyAt).toBeNull();
      expect(request.previewSha).toBeNull();
    });
  });

  it("ignores an edited review comment", async () => {
    const routes = happyRoutes();
    routes["/issues/101/comments"] = [
      {
        id: 5,
        body: reviewMarker("pass", FIRST),
        user: { login: AGENT_LOGIN, id: AGENT_ID },
        created_at: "2026-10-10T10:08:00Z",
        updated_at: "2026-10-10T10:50:00Z",
      },
    ];
    expect((await setup(routes).run()).requests[0].firstReview).toBe("none");
  });

  it("ignores a pull request that has the agent's login but is not a bot", async () => {
    const routes = happyRoutes();
    routes["/pulls"] = [pull(1, { user: { login: APP, type: "User" } })];
    expect((await setup(routes).run()).requests[0].hasPull).toBe(false);
  });

  it("drops a request in progress when the deadline passes during it", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const routes = happyRoutes();
      routes["/pulls/101/commits"] = () => {
        now = 5_000;
        return [{ sha: FIRST, author: { login: APP } }];
      };
      const result = await setup(routes, { deadline: 2_000 }).run();
      expect(result.stoppedEarly).toBe(true);
      expect(result.requests).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("stops before the next request once the deadline has passed", async () => {
    const routes = happyRoutes();
    routes["/issues"] = [issue(1), issue(2)];
    const result = await setup(routes, { deadline: Date.now() - 1000 }).run();
    expect(result.stoppedEarly).toBe(true);
    expect(result.requests).toEqual([]);
  });
});
