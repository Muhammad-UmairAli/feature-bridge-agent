/**
 * The three success metrics, computed from facts already read from GitHub
 * (see collect.mts). Pure: no network, no clock, standard library only.
 *
 * - M1: time from a request to its preview (and from its approval).
 * - M2: share of previewed requests with no human-authored commit first.
 * - M3: share of agent pull requests whose first commit passed CI and review.
 *
 * The report holds counts and percentages only, never request text, because
 * a job summary is readable by anyone who can read the repository.
 */

/** The target for M1, in minutes. */
export const PREVIEW_TARGET_MINUTES = 15;
/** The target for M2, as a percentage. */
export const ZERO_EDIT_TARGET_PCT = 80;

export type CiResult = "success" | "failure" | "pending" | "none";
export type ReviewResult = "pass" | "findings" | "error" | "none";

export interface CommitFact {
  sha: string;
  /** The commit author's GitHub login, or null when the author has no account. */
  authorLogin: string | null;
}

/** Everything the metrics need to know about one request. */
export interface RequestFacts {
  number: number;
  createdAt: string;
  /** When the approval that was built was applied, if known. */
  approvedAt: string | null;
  /** An agent pull request from this repository exists. */
  hasPull: boolean;
  /** When the first successful preview deployment finished. */
  previewReadyAt: string | null;
  /** The commit that first preview was built from. */
  previewSha: string | null;
  /** The branch's commits, oldest first. */
  commits: CommitFact[];
  /** CI result for the pull request's first commit. */
  firstCi: CiResult;
  /** Automated review result for the pull request's first commit. */
  firstReview: ReviewResult;
}

export interface Metrics {
  requests: number;
  withPull: number;
  /** The earliest creation time among the requests read, or null when none were. */
  oldestCreatedAt: string | null;
  m1: {
    n: number;
    medianMinutes: number | null;
    nFromApproval: number;
    medianFromApprovalMinutes: number | null;
    withinTargetPct: number | null;
    /** Requests with an agent pull request and no preview yet: in neither M1 nor M2. */
    withoutPreview: number;
  };
  m2: { n: number; zeroEdits: number; pct: number | null; unknown: number };
  m3: {
    n: number;
    passed: number;
    pct: number | null;
    /** The share if review errors counted as failures. */
    strictPct: number | null;
    reviewErrors: number;
    undecided: number;
  };
}

/** More than a fifth of the requests unreadable means something systematic is wrong. */
export function tooManyUnreadable(read: number, unreadable: number): boolean {
  return unreadable > 0 && unreadable * 5 > read + unreadable;
}

/** Minutes from `start` to `end`, or null when either is unusable or the order is wrong. */
function minutesBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return (to - from) / 60_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const percent = (part: number, whole: number) => (whole === 0 ? null : (part / whole) * 100);

export function computeMetrics(requests: RequestFacts[], agentLogin: string): Metrics {
  const agent = agentLogin.toLowerCase();

  const fromRequest: number[] = [];
  const fromApproval: number[] = [];
  const m2 = { n: 0, zeroEdits: 0, unknown: 0 };
  const m3 = { n: 0, passed: 0, reviewErrors: 0, undecided: 0 };
  let withoutPreview = 0;
  let oldest: number | null = null;
  let oldestCreatedAt: string | null = null;

  for (const request of requests) {
    const created = Date.parse(request.createdAt);
    if (Number.isFinite(created) && (oldest === null || created < oldest)) {
      oldest = created;
      oldestCreatedAt = request.createdAt;
    }
    if (request.hasPull && request.previewReadyAt === null) withoutPreview += 1;

    const sinceRequest = minutesBetween(request.createdAt, request.previewReadyAt);
    if (sinceRequest !== null) fromRequest.push(sinceRequest);
    const sinceApproval = minutesBetween(request.approvedAt, request.previewReadyAt);
    if (sinceApproval !== null) fromApproval.push(sinceApproval);

    if (request.previewSha !== null) {
      // Commits up to and including the previewed one: what the first preview was built from.
      const index = request.commits.findIndex((commit) => commit.sha === request.previewSha);
      if (index === -1) {
        m2.unknown += 1;
      } else {
        m2.n += 1;
        const edited = request.commits
          .slice(0, index + 1)
          .some((commit) => commit.authorLogin?.toLowerCase() !== agent);
        if (!edited) m2.zeroEdits += 1;
      }
    }

    if (request.hasPull && request.commits.length > 0) {
      // A failed CI run is a failed first attempt whatever the review said.
      if (request.firstCi === "failure") {
        m3.n += 1;
      } else if (request.firstReview === "error") {
        m3.reviewErrors += 1;
      } else if (
        request.firstCi === "success" &&
        (request.firstReview === "pass" || request.firstReview === "findings")
      ) {
        m3.n += 1;
        if (request.firstReview === "pass") m3.passed += 1;
      } else {
        m3.undecided += 1;
      }
    }
  }

  return {
    requests: requests.length,
    withPull: requests.filter((request) => request.hasPull).length,
    oldestCreatedAt,
    m1: {
      withoutPreview,
      n: fromRequest.length,
      medianMinutes: median(fromRequest),
      nFromApproval: fromApproval.length,
      medianFromApprovalMinutes: median(fromApproval),
      withinTargetPct: percent(
        fromRequest.filter((minutes) => minutes <= PREVIEW_TARGET_MINUTES).length,
        fromRequest.length,
      ),
    },
    m2: { ...m2, pct: percent(m2.zeroEdits, m2.n) },
    m3: {
      ...m3,
      pct: percent(m3.passed, m3.n),
      strictPct: percent(m3.passed, m3.n + m3.reviewErrors),
    },
  };
}

export interface ReportOptions {
  days: number;
  generatedAt: string;
  /** Requests whose data could not be read; they are left out. */
  unreadable: number;
  /** Requests left out because they had more comments than can be read safely. */
  tooBusy: number;
  /** The run hit its call budget or time limit before every request was read. */
  stoppedEarly: boolean;
  /** More requests were in the window than the run's request limit. */
  truncated: boolean;
  requestLimit: number;
}

const NO_DATA = "no data yet";
const minutesText = (minutes: number) =>
  minutes >= 120 ? `${(minutes / 60).toFixed(1)} h` : `${minutes.toFixed(1)} min`;
const percentText = (value: number) => `${value.toFixed(1)}%`;

/** The markdown report for the job summary. */
export function renderReport(metrics: Metrics, options: ReportOptions): string {
  const { m1, m2, m3 } = metrics;
  const sample = (n: number) => `n = ${n}`;

  const m1Result =
    m1.medianMinutes === null || m1.withinTargetPct === null
      ? NO_DATA
      : `${minutesText(m1.medianMinutes)} (target ${PREVIEW_TARGET_MINUTES} min or less; ${percentText(m1.withinTargetPct)} within target)`;
  const m1ApprovalResult =
    m1.medianFromApprovalMinutes === null ? NO_DATA : minutesText(m1.medianFromApprovalMinutes);
  const m2Result =
    m2.pct === null ? NO_DATA : `${percentText(m2.pct)} (target ${ZERO_EDIT_TARGET_PCT}%)`;
  const m3Result = m3.pct === null ? NO_DATA : `${percentText(m3.pct)} (no target set)`;

  const lines = [
    "# Success metrics",
    "",
    `Last ${options.days} days, generated ${options.generatedAt}. ${metrics.requests} request(s) read, ${metrics.withPull} with an agent pull request.`,
    "",
    "| Metric | Result | Sample |",
    "| --- | --- | --- |",
    `| M1 Median request to preview | ${m1Result} | ${sample(m1.n)} |`,
    `| M1 Median approval to preview | ${m1ApprovalResult} | ${sample(m1.nFromApproval)} |`,
    `| M2 Previewed requests with zero human code edits | ${m2Result} | ${sample(m2.n)} |`,
    `| M3 Agent pull requests passing CI and review on the first attempt | ${m3Result} | ${sample(m3.n)} |`,
  ];

  const notes: string[] = [];
  if (options.unreadable > 0) {
    notes.push(`${options.unreadable} request(s) could not be read and are left out.`);
  }
  if (options.tooBusy > 0) {
    notes.push(
      `${options.tooBusy} request(s) had more comments than can be read safely and are left out.`,
    );
  }
  if (options.truncated) {
    notes.push(
      `More requests were in the window than one run reads (limit ${options.requestLimit}); the oldest are left out.`,
    );
  }
  if (options.stoppedEarly) {
    notes.push(
      "The run stopped before reading every request (call budget or time limit reached); the oldest are left out.",
    );
  }
  if ((options.truncated || options.stoppedEarly) && metrics.oldestCreatedAt !== null) {
    notes.push(`The numbers cover requests created since ${metrics.oldestCreatedAt.slice(0, 10)}.`);
  }
  if (m1.withoutPreview > 0) {
    notes.push(
      `${m1.withoutPreview} request(s) with an agent pull request have no preview yet and are in neither M1 nor M2.`,
    );
  }
  if (m2.unknown > 0) {
    notes.push(
      `${m2.unknown} preview(s) set aside because the previewed commit is not on the branch.`,
    );
  }
  if (m3.reviewErrors > 0) {
    const strict =
      m3.strictPct === null
        ? ""
        : `; counting them as failures would give ${percentText(m3.strictPct)}`;
    notes.push(`${m3.reviewErrors} review error(s) left out of M3${strict}.`);
  }
  if (m3.undecided > 0) {
    notes.push(
      `${m3.undecided} pull request(s) have no final CI or review result yet (still running, cancelled, or no longer kept by GitHub).`,
    );
  }
  if (notes.length > 0) lines.push("", ...notes.map((note) => `- ${note}`));

  lines.push(
    "",
    "## Definitions",
    "",
    "These are working assumptions, not settled definitions.",
    "",
    "- Requests are issues created by the portal bot in the window. Metrics use those with an agent pull request on branch `request-<number>` in this repository.",
    "- M1: from issue creation to the first successful deployment on that branch. The second row starts at the last approval before the pull request opened, because it is open whether time spent waiting for approval counts.",
    "- M2: every commit up to the one the first preview was built from was authored by the coding agent. A commit with no GitHub account counts as human.",
    "- M3: the pull request's first commit had a successful CI run (the newest run, so a re-run that passes counts) and an automated review of `pass`. A failed CI run counts as a failed attempt whatever the review said; otherwise a review error is left out.",
  );

  return `${lines.join("\n")}\n`;
}
