// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type RequestFacts, computeMetrics, renderReport, tooManyUnreadable } from "./compute.mts";

const AGENT = "coder-app[bot]";
const T0 = "2026-10-01T10:00:00Z";
const at = (offsetSeconds: number) =>
  new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString().replace(".000Z", "Z");

/** A request that reached a preview `previewAfter` seconds after it was created. */
function request(number: number, overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    number,
    createdAt: T0,
    approvedAt: at(60),
    hasPull: true,
    previewReadyAt: at(600),
    previewSha: "a".repeat(40),
    commits: [{ sha: "a".repeat(40), authorLogin: AGENT }],
    firstCi: "success",
    firstReview: "pass",
    ...overrides,
  };
}

describe("computeMetrics: M1 request to preview", () => {
  it("takes the median of an odd and an even number of requests", () => {
    const odd = computeMetrics(
      [
        request(1, { previewReadyAt: at(10 * 60) }),
        request(2, { previewReadyAt: at(30 * 60) }),
        request(3, { previewReadyAt: at(20 * 60) }),
      ],
      AGENT,
    );
    expect(odd.m1.medianMinutes).toBe(20);

    const even = computeMetrics(
      [
        request(1, { previewReadyAt: at(10 * 60) }),
        request(2, { previewReadyAt: at(20 * 60) }),
        request(3, { previewReadyAt: at(30 * 60) }),
        request(4, { previewReadyAt: at(40 * 60) }),
      ],
      AGENT,
    );
    expect(even.m1.medianMinutes).toBe(25);
  });

  it("counts exactly 15 minutes as within the target, one second more as outside", () => {
    const result = computeMetrics(
      [
        request(1, { previewReadyAt: at(15 * 60) }),
        request(2, { previewReadyAt: at(15 * 60 + 1) }),
      ],
      AGENT,
    );
    expect(result.m1.n).toBe(2);
    expect(result.m1.withinTargetPct).toBe(50);
  });

  it("measures from approval separately and skips requests without an approval time", () => {
    const result = computeMetrics(
      [
        request(1, { approvedAt: at(5 * 60), previewReadyAt: at(15 * 60) }),
        request(2, { approvedAt: null, previewReadyAt: at(25 * 60) }),
      ],
      AGENT,
    );
    expect(result.m1.medianMinutes).toBe(20);
    expect(result.m1.nFromApproval).toBe(1);
    expect(result.m1.medianFromApprovalMinutes).toBe(10);
  });

  it("leaves out requests with no preview yet, and ignores unusable timestamps", () => {
    const result = computeMetrics(
      [
        request(1, { previewReadyAt: null, previewSha: null }),
        request(2, { previewReadyAt: "not a date" }),
        request(3, { previewReadyAt: at(12 * 60) }),
      ],
      AGENT,
    );
    expect(result.m1.n).toBe(1);
    expect(result.m1.medianMinutes).toBe(12);
  });

  it("reports no data rather than NaN when nothing qualifies", () => {
    const result = computeMetrics([], AGENT);
    expect(result.m1).toEqual({
      n: 0,
      medianMinutes: null,
      nFromApproval: 0,
      medianFromApprovalMinutes: null,
      withinTargetPct: null,
      withoutPreview: 0,
    });
    expect(result.oldestCreatedAt).toBeNull();
    expect(result.m2.pct).toBeNull();
    expect(result.m3.pct).toBeNull();
  });
});

describe("computeMetrics: M2 zero human code edits", () => {
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  const third = "3".repeat(40);

  it("passes when every commit up to the previewed one is the agent's", () => {
    const result = computeMetrics(
      [
        request(1, {
          previewSha: second,
          commits: [
            { sha: first, authorLogin: AGENT },
            { sha: second, authorLogin: AGENT },
          ],
        }),
      ],
      AGENT,
    );
    expect(result.m2).toMatchObject({ n: 1, zeroEdits: 1, pct: 100, unknown: 0 });
  });

  it("fails on a human commit before the preview, but not one made after it", () => {
    const result = computeMetrics(
      [
        request(1, {
          previewSha: third,
          commits: [
            { sha: first, authorLogin: AGENT },
            { sha: second, authorLogin: "maintainer" },
            { sha: third, authorLogin: AGENT },
          ],
        }),
        request(2, {
          previewSha: first,
          commits: [
            { sha: first, authorLogin: AGENT },
            { sha: second, authorLogin: "maintainer" },
          ],
        }),
      ],
      AGENT,
    );
    expect(result.m2).toMatchObject({ n: 2, zeroEdits: 1, pct: 50 });
  });

  it("treats a commit with no GitHub account as human, since it can't be tied to the agent", () => {
    const result = computeMetrics(
      [request(1, { previewSha: first, commits: [{ sha: first, authorLogin: null }] })],
      AGENT,
    );
    expect(result.m2).toMatchObject({ n: 1, zeroEdits: 0, pct: 0 });
  });

  it("sets aside a preview whose commit is not on the branch (for example after a force push)", () => {
    const result = computeMetrics(
      [request(1, { previewSha: third, commits: [{ sha: first, authorLogin: AGENT }] })],
      AGENT,
    );
    expect(result.m2).toMatchObject({ n: 0, unknown: 1, pct: null });
  });

  it("ignores requests that never reached a preview", () => {
    const result = computeMetrics([request(1, { previewReadyAt: null, previewSha: null })], AGENT);
    expect(result.m2).toMatchObject({ n: 0, unknown: 0 });
  });
});

describe("computeMetrics: M3 first attempt passes CI and review", () => {
  it("counts a pass only when CI succeeded and the review passed", () => {
    const result = computeMetrics(
      [
        request(1),
        request(2, { firstCi: "failure" }),
        request(3, { firstReview: "findings" }),
        request(4, { firstCi: "failure", firstReview: "findings" }),
      ],
      AGENT,
    );
    expect(result.m3).toMatchObject({ n: 4, passed: 1, pct: 25, reviewErrors: 0, undecided: 0 });
  });

  it("leaves a review error out of the percentage and reports it", () => {
    const result = computeMetrics([request(1), request(2, { firstReview: "error" })], AGENT);
    expect(result.m3).toMatchObject({ n: 1, passed: 1, pct: 100, reviewErrors: 1 });
  });

  it("counts a failed CI run as a failed attempt even when the review errored", () => {
    const result = computeMetrics(
      [request(1, { firstCi: "failure", firstReview: "error" })],
      AGENT,
    );
    expect(result.m3).toMatchObject({ n: 1, passed: 0, pct: 0, reviewErrors: 0 });
  });

  it("leaves requests still waiting on CI or the review out, and counts them", () => {
    const result = computeMetrics(
      [
        request(1),
        request(2, { firstCi: "pending" }),
        request(3, { firstCi: "none" }),
        request(4, { firstReview: "none" }),
      ],
      AGENT,
    );
    expect(result.m3).toMatchObject({ n: 1, passed: 1, undecided: 3 });
  });

  it("only looks at requests that have an agent pull request with commits", () => {
    const result = computeMetrics(
      [request(1, { hasPull: false, commits: [] }), request(2, { commits: [] }), request(3)],
      AGENT,
    );
    expect(result.requests).toBe(3);
    expect(result.withPull).toBe(2);
    expect(result.m3.n).toBe(1);
  });
});

describe("renderReport", () => {
  const options = {
    days: 90,
    generatedAt: "2026-10-14T10:00:00Z",
    unreadable: 0,
    tooBusy: 0,
    stoppedEarly: false,
    truncated: false,
    requestLimit: 100,
  };

  it("shows each metric with its sample size and states the definitions it assumed", () => {
    const metrics = computeMetrics(
      [request(1, { previewReadyAt: at(12 * 60) }), request(2, { previewReadyAt: at(18 * 60) })],
      AGENT,
    );
    const report = renderReport(metrics, options);
    expect(report).toContain("# Success metrics");
    expect(report).toContain("Last 90 days");
    expect(report).toMatch(/M1[^\n]*15\.0 min[^\n]*n = 2/);
    expect(report).toMatch(/M2[^\n]*100\.0%/);
    expect(report).toMatch(/M3[^\n]*100\.0%/);
    expect(report).toContain("Definitions");
    expect(report).not.toContain("NaN");
  });

  it("says there is no data yet instead of printing numbers", () => {
    const report = renderReport(computeMetrics([], AGENT), options);
    expect(report).toContain("no data yet");
    expect(report).not.toMatch(/NaN|undefined|null/);
  });

  it("formats long times in hours and reports what could not be read or was left out", () => {
    const metrics = computeMetrics(
      [
        request(1, { previewReadyAt: at(3 * 3600) }),
        request(2, { previewReadyAt: at(3 * 3600), firstReview: "error" }),
      ],
      AGENT,
    );
    const report = renderReport(metrics, { ...options, unreadable: 2, stoppedEarly: true });
    expect(report).toContain("3.0 h");
    expect(report).toMatch(/2 request\(s\) could not be read/);
    expect(report).toMatch(/stopped before reading every request/);
    expect(report).toMatch(/1 review error/);
  });

  it("contains only counts, percentages and dates, never logins or free text", () => {
    const report = renderReport(computeMetrics([request(7)], AGENT), options);
    expect(report).not.toContain("coder-app");
  });
});

describe("computeMetrics: coverage", () => {
  it("drops a preview time that is before the request was created", () => {
    const result = computeMetrics([request(1, { previewReadyAt: at(-60) })], AGENT);
    expect(result.m1.n).toBe(0);
  });

  it("measures M1 and M2 independently when a preview time exists but its commit is unknown", () => {
    const result = computeMetrics([request(1, { previewSha: null })], AGENT);
    expect(result.m1.n).toBe(1);
    expect(result.m2).toMatchObject({ n: 0, unknown: 0 });
  });

  it("counts requests with an agent pull request but no preview, and none without a pull request", () => {
    const result = computeMetrics(
      [
        request(1, { previewReadyAt: null, previewSha: null }),
        request(2, { previewReadyAt: null, previewSha: null, hasPull: false, commits: [] }),
        request(3),
      ],
      AGENT,
    );
    expect(result.m1.withoutPreview).toBe(1);
  });

  it("finds the oldest request read", () => {
    const result = computeMetrics(
      [
        request(1, { createdAt: "2026-10-05T00:00:00Z" }),
        request(2, { createdAt: "2026-09-20T12:00:00Z" }),
        request(3, { createdAt: "not a date" }),
      ],
      AGENT,
    );
    expect(result.oldestCreatedAt).toBe("2026-09-20T12:00:00Z");
  });

  it("also gives the share when review errors count as failures", () => {
    const passing = Array.from({ length: 5 }, (_, index) => request(index + 1));
    const errored = Array.from({ length: 5 }, (_, index) =>
      request(index + 10, { firstReview: "error" }),
    );
    const result = computeMetrics([...passing, ...errored], AGENT);
    expect(result.m3).toMatchObject({ n: 5, pct: 100, strictPct: 50, reviewErrors: 5 });
  });
});

describe("tooManyUnreadable", () => {
  it("flags more than a fifth of the requests, and any when none could be read", () => {
    expect(tooManyUnreadable(0, 0)).toBe(false);
    expect(tooManyUnreadable(9, 1)).toBe(false);
    expect(tooManyUnreadable(8, 2)).toBe(false);
    expect(tooManyUnreadable(7, 3)).toBe(true);
    expect(tooManyUnreadable(0, 1)).toBe(true);
  });
});

describe("renderReport: caveats", () => {
  const base = {
    days: 90,
    generatedAt: "2026-10-14T10:00:00Z",
    unreadable: 0,
    tooBusy: 0,
    stoppedEarly: false,
    truncated: false,
    requestLimit: 100,
  };
  const metrics = computeMetrics(
    [request(1, { createdAt: "2026-09-20T12:00:00Z", previewReadyAt: null, previewSha: null })],
    AGENT,
  );

  it("says so when the request limit cut the window short, and from when the numbers cover", () => {
    const report = renderReport(metrics, { ...base, truncated: true });
    expect(report).toContain("limit 100");
    expect(report).toContain("created since 2026-09-20");
  });

  it("says so when the run stopped early, and from when the numbers cover", () => {
    const report = renderReport(metrics, { ...base, stoppedEarly: true });
    expect(report).toContain("stopped before reading every request");
    expect(report).toContain("created since 2026-09-20");
  });

  it("stays quiet about coverage when everything was read", () => {
    expect(renderReport(metrics, base)).not.toContain("created since");
  });

  it("reports requests left out for too many comments", () => {
    expect(renderReport(metrics, { ...base, tooBusy: 2 })).toMatch(
      /2 request\(s\) had more comments than can be read safely/,
    );
  });

  it("reports requests with a pull request but no preview", () => {
    expect(renderReport(metrics, base)).toMatch(
      /1 request\(s\) with an agent pull request have no preview yet/,
    );
  });

  it("gives the strict M3 share next to review errors", () => {
    const errored = computeMetrics([request(1), request(2, { firstReview: "error" })], AGENT);
    expect(renderReport(errored, base)).toContain("counting them as failures would give 50.0%");
  });
});
