// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearInstallationTokenCache } from "@/lib/github/app-auth";
import { TEST_APP_CONFIG, tokenRoute } from "@/test/github-fixtures";

import {
  MAX_PAGES,
  assertWithinDailyCap,
  countTodaysRequests,
  resetDailyCapMemory,
  startOfUtcDay,
} from "./daily-cap";
import { LABELS } from "./labels";

const NOW = Date.UTC(2026, 9, 7, 15, 30); // 2026-10-07 15:30 UTC
const at = (iso: string) => ({ created_at: iso, user: { type: "Bot" } });
const TODAY_BOT = at("2026-10-07T09:00:00Z");

/** Fake GitHub serving the given pages of the issues list (newest first). */
function fakeIssues(pages: unknown[][]) {
  const listCalls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (init.method === "POST" && url.pathname.endsWith("/access_tokens")) return tokenRoute(init);
    if (url.pathname === "/repos/octo-org/requests/issues") {
      listCalls.push(url);
      const page = Number(url.searchParams.get("page"));
      return Response.json(pages[page - 1] ?? []);
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, listCalls };
}

beforeEach(() => {
  clearInstallationTokenCache();
  resetDailyCapMemory();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("startOfUtcDay", () => {
  it("is midnight UTC of the current day", () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(startOfUtcDay(Date.UTC(2026, 9, 7, 23, 59, 59)).toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });
});

describe("countTodaysRequests", () => {
  it("counts only today's bot-created issues, not pull requests or human issues", async () => {
    const { fetchImpl, listCalls } = fakeIssues([
      [
        TODAY_BOT,
        { ...TODAY_BOT, pull_request: { url: "x" } },
        { created_at: "2026-10-07T08:00:00Z", user: { type: "User" } },
        at("2026-10-07T00:00:00Z"), // exactly midnight counts
        at("2026-10-06T23:59:59Z"), // yesterday ends the count
        at("2026-10-07T07:00:00Z"), // never reached
      ],
    ]);
    expect(await countTodaysRequests(TEST_APP_CONFIG, 50, { fetchImpl, nowMs: NOW })).toBe(2);
    const query = listCalls[0].searchParams;
    expect(query.get("labels")).toBe(LABELS.portalRequest);
    expect(query.get("state")).toBe("all");
    expect(query.get("sort")).toBe("created");
    expect(query.get("direction")).toBe("desc");
    expect(query.get("since")).toBe("2026-10-07T00:00:00.000Z");
  });

  it("pages through full pages and stops early at the cap", async () => {
    const full = Array.from({ length: 100 }, () => TODAY_BOT);
    const paged = fakeIssues([full, [TODAY_BOT, TODAY_BOT]]);
    expect(
      await countTodaysRequests(TEST_APP_CONFIG, 500, { fetchImpl: paged.fetchImpl, nowMs: NOW }),
    ).toBe(102);
    expect(paged.listCalls).toHaveLength(2);

    const capped = fakeIssues([full, full]);
    expect(
      await countTodaysRequests(TEST_APP_CONFIG, 20, { fetchImpl: capped.fetchImpl, nowMs: NOW }),
    ).toBe(20);
    expect(capped.listCalls).toHaveLength(1);
  });

  it("uses a read-only installation token", async () => {
    const { fetchImpl } = fakeIssues([[]]);
    await countTodaysRequests(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW });
    const tokenCall = vi
      .mocked(fetchImpl)
      .mock.calls.find(([url]) => String(url).includes("access_tokens"));
    expect(JSON.parse(String(tokenCall![1]!.body)).permissions).toEqual({ issues: "read" });
  });
});

describe("assertWithinDailyCap", () => {
  it("allows submissions below the cap", async () => {
    const { fetchImpl } = fakeIssues([Array.from({ length: 19 }, () => TODAY_BOT)]);
    await expect(
      assertWithinDailyCap(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW }),
    ).resolves.toBeUndefined();
  });

  it("rejects with 429 at the cap", async () => {
    const { fetchImpl } = fakeIssues([Array.from({ length: 20 }, () => TODAY_BOT)]);
    await expect(
      assertWithinDailyCap(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW }),
    ).rejects.toMatchObject({
      status: 429,
      code: "DAILY_LIMIT_REACHED",
    });
  });

  it("fails closed when GitHub can't be read", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) =>
      String(input).includes("access_tokens")
        ? tokenRoute(init)
        : new Response("", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      assertWithinDailyCap(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW }),
    ).rejects.toMatchObject({
      status: 503,
    });
  });

  it("remembers a reached cap until midnight UTC without calling GitHub again", async () => {
    const { fetchImpl, listCalls } = fakeIssues([Array.from({ length: 20 }, () => TODAY_BOT)]);
    await expect(
      assertWithinDailyCap(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      assertWithinDailyCap(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW + 60_000 }),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(listCalls).toHaveLength(1);
    const tomorrow = Date.UTC(2026, 9, 8, 0, 0, 1);
    await expect(
      assertWithinDailyCap(TEST_APP_CONFIG, 20, {
        fetchImpl: fakeIssues([[]]).fetchImpl,
        nowMs: tomorrow,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("fails closed when the count is uncertain", () => {
  it("returns 503 when pages run out before reaching yesterday or the cap", async () => {
    const humans = Array.from({ length: 100 }, () => ({
      created_at: "2026-10-07T09:00:00Z",
      user: { type: "User" },
    }));
    const { fetchImpl, listCalls } = fakeIssues(
      Array.from({ length: MAX_PAGES + 1 }, () => humans),
    );
    await expect(
      countTodaysRequests(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW }),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(listCalls).toHaveLength(MAX_PAGES);
  });

  it("returns 502 for a non-list reply or an unreadable date", async () => {
    const notList = fakeIssues([{ message: "weird" } as unknown as unknown[]]);
    await expect(
      countTodaysRequests(TEST_APP_CONFIG, 20, { fetchImpl: notList.fetchImpl, nowMs: NOW }),
    ).rejects.toMatchObject({
      status: 502,
    });
    const badDate = fakeIssues([[{ created_at: "yesterday-ish", user: { type: "Bot" } }]]);
    await expect(
      countTodaysRequests(TEST_APP_CONFIG, 20, { fetchImpl: badDate.fetchImpl, nowMs: NOW }),
    ).rejects.toMatchObject({
      status: 502,
    });
  });

  it("retries once with a fresh token after a 401", async () => {
    let listAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).includes("access_tokens")) return tokenRoute(init);
      return ++listAttempts === 1 ? new Response("", { status: 401 }) : Response.json([TODAY_BOT]);
    }) as unknown as typeof fetch;
    expect(await countTodaysRequests(TEST_APP_CONFIG, 20, { fetchImpl, nowMs: NOW })).toBe(1);
    const tokenCalls = vi
      .mocked(fetchImpl)
      .mock.calls.filter(([url]) => String(url).includes("access_tokens"));
    expect(tokenCalls).toHaveLength(2);
  });
});
