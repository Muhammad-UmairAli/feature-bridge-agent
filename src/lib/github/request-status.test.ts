// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS } from "@/lib/requests/labels";
import { TEST_APP_CONFIG, fakeGitHub, tokenRoute } from "@/test/github-fixtures";

import { clearInstallationTokenCache } from "./app-auth";
import {
  clearRequestStatusCache,
  getRequestStatus,
  requestBranch,
  safePreviewUrl,
} from "./request-status";

const REPO = "/repos/octo-org/requests";
const SHA = "a".repeat(40);
const PREVIEW = "https://feature-bridge-agent-git-request-5.vercel.app/";
const suffixes = [".vercel.app"];

const issue = (overrides: Record<string, unknown> = {}) => ({
  number: 5,
  title: "Feature request: Add dark mode",
  state: "open",
  created_at: "2026-10-07T09:00:00Z",
  html_url: "https://github.com/octo-org/requests/issues/5",
  user: { type: "Bot" },
  labels: [{ name: LABELS.portalRequest }],
  ...overrides,
});
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 9,
  state: "open",
  html_url: "https://github.com/octo-org/requests/pull/9",
  merged_at: null,
  user: { type: "Bot" },
  head: { sha: SHA, repo: { full_name: "octo-org/requests" } },
  ...overrides,
});

function routes(extra: Record<string, () => Response> = {}) {
  return fakeGitHub({
    "POST /app/installations/456/access_tokens": tokenRoute,
    [`GET ${REPO}/issues/5`]: () => Response.json(issue()),
    [`GET ${REPO}/pulls`]: () => Response.json([]),
    ...extra,
  });
}
const get = (fetchImpl: ReturnType<typeof fakeGitHub>, nowMs?: number) =>
  getRequestStatus(TEST_APP_CONFIG, 5, { fetchImpl, nowMs, previewHostSuffixes: suffixes });
const githubCalls = (fetchImpl: ReturnType<typeof fakeGitHub>) =>
  fetchImpl.mock.calls.filter(([url]) => !String(url).includes("access_tokens"));

beforeEach(() => {
  clearInstallationTokenCache();
  clearRequestStatusCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getRequestStatus", () => {
  it("returns a submitted request with read-only access and two calls", async () => {
    const fetchImpl = routes();
    expect(await get(fetchImpl)).toEqual({
      id: 5,
      title: "Feature request: Add dark mode",
      status: "submitted",
      createdAt: "2026-10-07T09:00:00Z",
      issueUrl: "https://github.com/octo-org/requests/issues/5",
      pullRequest: null,
      previewUrl: null,
    });
    const tokenCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("access_tokens"));
    expect(JSON.parse(String(tokenCall![1]!.body)).permissions).toEqual({
      issues: "read",
      pull_requests: "read",
      deployments: "read",
    });
    expect(githubCalls(fetchImpl)).toHaveLength(2);
  });

  it("looks up the agent's PR by its branch in this repository", async () => {
    const fetchImpl = routes();
    await get(fetchImpl);
    const pullsCall = githubCalls(fetchImpl).find(
      ([url]) => new URL(String(url)).pathname === `${REPO}/pulls`,
    );
    const query = new URL(String(pullsCall![0])).searchParams;
    expect(query.get("head")).toBe(`octo-org:${requestBranch(5)}`);
    expect(query.get("state")).toBe("all");
    expect(query.get("per_page")).toBe("1");
  });

  it("treats missing, deleted and non-portal issues as not found", async () => {
    const cases = [
      () => new Response("", { status: 404 }),
      () => new Response("", { status: 410 }),
      () => Response.json(issue({ user: { type: "User" } })),
      () => Response.json(issue({ labels: [] })),
      () => Response.json(issue({ pull_request: { url: "x" } })),
      () => Response.json(issue({ html_url: "https://evil.example/octo-org/requests/issues/5" })),
    ];
    for (const issueRoute of cases) {
      clearRequestStatusCache();
      expect(await get(routes({ [`GET ${REPO}/issues/5`]: issueRoute }))).toBeNull();
    }
  });

  it("ignores pull requests that aren't the agent's (human author or fork head)", async () => {
    for (const other of [
      pull({ user: { type: "User" } }),
      pull({ head: { sha: SHA, repo: { full_name: "someone/fork" } } }),
    ]) {
      clearRequestStatusCache();
      const view = await get(routes({ [`GET ${REPO}/pulls`]: () => Response.json([other]) }));
      expect(view?.status).toBe("submitted");
      expect(view?.pullRequest).toBeNull();
    }
  });

  it("shows an open agent PR with its preview", async () => {
    const fetchImpl = routes({
      [`GET ${REPO}/pulls`]: () => Response.json([pull()]),
      [`GET ${REPO}/deployments`]: () =>
        Response.json([{ id: 99, production_environment: false, creator: { type: "Bot" } }]),
      [`GET ${REPO}/deployments/99/statuses`]: () =>
        Response.json([{ state: "success", environment_url: PREVIEW }]),
    });
    const view = await get(fetchImpl);
    expect(view?.pullRequest).toEqual({
      number: 9,
      url: "https://github.com/octo-org/requests/pull/9",
    });
    expect(view?.previewUrl).toBe(PREVIEW);
    expect(view?.status).toBe("preview-ready");
    expect(githubCalls(fetchImpl)).toHaveLength(4); // the per-view maximum
  });

  it("only trusts the newest status of a non-production, bot-created deployment", async () => {
    const cases: [unknown[], unknown[]][] = [
      [
        [{ id: 99, production_environment: true, creator: { type: "Bot" } }],
        [{ state: "success", environment_url: PREVIEW }],
      ],
      [
        [{ id: 99, production_environment: false, creator: { type: "User" } }],
        [{ state: "success", environment_url: PREVIEW }],
      ],
      [
        [{ id: 99, production_environment: false, creator: { type: "Bot" } }],
        [{ state: "inactive" }, { state: "success", environment_url: PREVIEW }],
      ],
      [
        [{ id: 99, production_environment: false, creator: { type: "Bot" } }],
        [{ state: "success", environment_url: "https://evil.example/" }],
      ],
    ];
    for (const [deployments, statuses] of cases) {
      clearRequestStatusCache();
      const view = await get(
        routes({
          [`GET ${REPO}/pulls`]: () => Response.json([pull()]),
          [`GET ${REPO}/deployments`]: () => Response.json(deployments),
          [`GET ${REPO}/deployments/99/statuses`]: () => Response.json(statuses),
        }),
      );
      expect(view?.previewUrl).toBeNull();
      expect(view?.status).toBe("in-review");
    }
  });

  it("shows a merged PR as live without looking for a preview", async () => {
    const fetchImpl = routes({
      [`GET ${REPO}/issues/5`]: () => Response.json(issue({ state: "closed" })),
      [`GET ${REPO}/pulls`]: () =>
        Response.json([pull({ state: "closed", merged_at: "2026-10-07T14:00:00Z" })]),
    });
    expect((await get(fetchImpl))?.status).toBe("merged");
    expect(githubCalls(fetchImpl).some(([url]) => String(url).includes("deployments"))).toBe(false);
  });

  it("keeps the page working when the preview lookup fails", async () => {
    const view = await get(
      routes({
        [`GET ${REPO}/pulls`]: () => Response.json([pull()]),
        [`GET ${REPO}/deployments`]: () => new Response("", { status: 500 }),
      }),
    );
    expect(view?.status).toBe("in-review");
    expect(view?.previewUrl).toBeNull();
  });
});

describe("protecting the shared rate limit", () => {
  it("shares one lookup between concurrent views of the same request", async () => {
    const fetchImpl = routes();
    await Promise.all([get(fetchImpl), get(fetchImpl), get(fetchImpl)]);
    const issueCalls = githubCalls(fetchImpl).filter(
      ([url]) => new URL(String(url)).pathname === `${REPO}/issues/5`,
    );
    expect(issueCalls).toHaveLength(1);
  });

  it("caches found requests for 30 s and not-found ids for 10 minutes", async () => {
    const now = Date.now();
    const found = routes();
    await get(found, now);
    await get(found, now + 20_000);
    expect(githubCalls(found)).toHaveLength(2);
    await get(found, now + 31_000);
    expect(githubCalls(found)).toHaveLength(4);

    clearRequestStatusCache();
    const missing = routes({ [`GET ${REPO}/issues/5`]: () => new Response("", { status: 404 }) });
    await get(missing, now);
    await get(missing, now + 9 * 60_000);
    expect(githubCalls(missing)).toHaveLength(1);
  });

  it("pauses lookups for a minute after a rate limit or outage", async () => {
    const now = Date.now();
    const limited = routes({ [`GET ${REPO}/issues/5`]: () => new Response("", { status: 429 }) });
    await expect(get(limited, now)).rejects.toMatchObject({ status: 503 });
    const healthy = routes();
    await expect(get(healthy, now + 30_000)).rejects.toMatchObject({ status: 503 });
    expect(githubCalls(healthy)).toHaveLength(0);
    await expect(get(healthy, now + 61_000)).resolves.toMatchObject({ status: "submitted" });
  });
});

describe("safePreviewUrl", () => {
  it("accepts https URLs on allowed hosts only", () => {
    expect(safePreviewUrl(PREVIEW, suffixes)).toBe(PREVIEW);
    for (const bad of [
      "http://x.vercel.app/",
      "https://user@x.vercel.app/",
      "https://evil.example/",
      "javascript:alert(1)",
      42,
    ]) {
      expect(safePreviewUrl(bad, suffixes)).toBeNull();
    }
  });
});
