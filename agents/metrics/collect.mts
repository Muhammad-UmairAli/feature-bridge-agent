/**
 * Reads, with a read-only token, the facts the metrics need about each portal
 * request (see compute.mts for how they are used). Standard library only.
 *
 * Everything is found by convention, as the tracking page does: the coding
 * agent builds request N on branch `request-N` in this repository, so only a
 * pull request from that branch, in this repository, by the coding agent App
 * counts; deployments, CI runs and review verdicts must belong to that pull
 * request's commits. Outsiders can't change what is reported by opening
 * look-alike branches, forks or comments.
 *
 * Calls are budgeted: the workflow's token allows about 1,000 calls an hour
 * for the whole repository, and one request costs eight to eleven. Errors
 * carry the operation and status only, never response bodies or the token.
 * Whatever a run can't read is counted and reported, never dropped silently.
 */
import { GitHubApiError } from "../lib/github.mts";
import { AGENT_ID, AGENT_LOGIN } from "../planner/planner.mts";
import { REVIEW_MARKER } from "../reviewer/review.mts";
import type { CiResult, CommitFact, RequestFacts, ReviewResult } from "./compute.mts";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_500;
const PAGE = 100;
/** Pages read for one list of commits, comments or events; more is "too busy" to read safely. */
const MAX_PAGES = 5;
const MAX_ISSUE_PAGES = 10;
/** Deployments examined per request, oldest first: the first preview is among them. */
const MAX_DEPLOYMENTS = 10;
const PORTAL_LABEL = "portal-request";
const APPROVAL_LABEL = "approved-by-human";
const CI_WORKFLOW = "CI";
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;

export interface CollectOptions {
  /** owner/name */
  repo: string;
  token: string;
  /** The portal's bot login: only issues it created are requests. */
  portalBotLogin: string;
  /** The coding agent App's bot login: only its pull requests and commits count as the agent's. */
  agentAppLogin: string;
  days: number;
  maxRequests: number;
  /** The most GitHub calls this run may make. */
  callBudget: number;
  now: Date;
  /** Epoch milliseconds after which no further request is started. */
  deadline?: number;
  fetchImpl?: typeof fetch;
  /** Waits before a retry; replaced in tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Receives one short line per request that could not be read. */
  log?: (line: string) => void;
}

export interface CollectResult {
  requests: RequestFacts[];
  /** Requests that could not be read and were left out. */
  unreadable: number;
  /** Requests left out because a list on them was too long to read safely. */
  tooBusy: number;
  /** The call budget or the deadline came before every request was read. */
  stoppedEarly: boolean;
  /** More requests were in the window than `maxRequests`. */
  truncated: boolean;
}

class BudgetExceeded extends Error {}
/** A list longer than the run reads; the request is left out and reported. */
class TooBusy extends Error {}

type Raw = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): Raw => (value && typeof value === "object" ? (value as Raw) : {});
const sameLogin = (a: unknown, b: string) => text(a).toLowerCase() === b.toLowerCase();
const time = (value: unknown) => Date.parse(text(value));
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface RequestIssue {
  number: number;
  createdAt: string;
}

export async function collectFacts(options: CollectOptions): Promise<CollectResult> {
  const { repo, portalBotLogin, agentAppLogin } = options;
  if (!REPO.test(repo)) throw new Error("GITHUB_REPOSITORY must look like owner/name");
  const owner = repo.split("/")[0];
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = options.sleep ?? wait;
  const log = options.log ?? (() => {});
  let calls = 0;

  /** One read. Retried once on a network error or 502/503/504; every attempt counts. */
  async function get(operation: string, path: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      if (calls >= options.callBudget) throw new BudgetExceeded();
      calls += 1;
      let response: Response;
      try {
        response = await fetchImpl(`${API}/repos/${repo}${path}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "feature-bridge-agent",
          },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // A fresh error: fetch's own can echo request details.
        if (attempt < 2) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new GitHubApiError(operation, 0);
      }
      if (response.ok) {
        // A fresh error: a JSON parse error can quote the start of the body.
        return response.json().catch(() => {
          throw new GitHubApiError(operation, 0);
        });
      }
      await response.body?.cancel().catch(() => {});
      if (attempt < 2 && [502, 503, 504].includes(response.status)) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new GitHubApiError(operation, response.status);
    }
  }

  /** Every item of a paged list (at most MAX_PAGES pages, else TooBusy). */
  async function list(operation: string, path: string): Promise<Raw[]> {
    const joiner = path.includes("?") ? "&" : "?";
    const items: Raw[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await get(operation, `${path}${joiner}per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GitHub ${operation} returned a non-list`);
      items.push(...batch.map(record));
      if (batch.length < PAGE) return items;
    }
    throw new TooBusy(`too many items to read safely (${operation})`);
  }

  /**
   * Portal-created request issues inside the window, newest first. Only the
   * number and creation time are kept: nothing else about an issue is needed,
   * so none of its text can reach a report.
   */
  async function listRequestIssues(): Promise<{ issues: RequestIssue[]; truncated: boolean }> {
    const cutoff = options.now.getTime() - options.days * 86_400_000;
    const issues: RequestIssue[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
      const batch = await get(
        "issues.list",
        `/issues?labels=${PORTAL_LABEL}&state=all&sort=created&direction=desc&per_page=${PAGE}&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error("GitHub issues.list returned a non-list");
      for (const item of batch.map(record)) {
        const created = time(item.created_at);
        if (!Number.isFinite(created)) continue;
        if (created < cutoff) return { issues, truncated: false }; // newest first: the rest is older
        const user = record(item.user);
        const isRequest =
          item.pull_request === undefined &&
          text(user.type) === "Bot" &&
          sameLogin(user.login, portalBotLogin) &&
          typeof item.number === "number";
        if (!isRequest) continue;
        // One more than the limit proves there were more.
        if (issues.length >= options.maxRequests) return { issues, truncated: true };
        issues.push({ number: item.number as number, createdAt: text(item.created_at) });
      }
      if (batch.length < PAGE) return { issues, truncated: false };
    }
    // Every page was full and none reached the cutoff: older requests were not read.
    return { issues, truncated: true };
  }

  /**
   * The first successful preview of the pull request's commits: the oldest
   * deployment, made by a bot and not to production, that has a success status.
   */
  async function firstPreview(
    branch: string,
    shas: Set<string>,
  ): Promise<{ readyAt: string; sha: string } | null> {
    const deployments = (await list("deployments.list", `/deployments?ref=${branch}`))
      .filter(
        (deployment) =>
          shas.has(text(deployment.sha)) &&
          typeof deployment.id === "number" &&
          deployment.production_environment !== true &&
          record(deployment.creator).type === "Bot",
      )
      .sort((a, b) => time(a.created_at) - time(b.created_at))
      .slice(0, MAX_DEPLOYMENTS);
    for (const deployment of deployments) {
      const statuses = await list("deployments.statuses", `/deployments/${deployment.id}/statuses`);
      const successes = statuses
        .filter((status) => status.state === "success" && Number.isFinite(time(status.created_at)))
        .sort((a, b) => time(a.created_at) - time(b.created_at));
      if (successes[0]) {
        return { readyAt: text(successes[0].created_at), sha: text(deployment.sha) };
      }
    }
    return null;
  }

  /** CI for one commit: the newest finished CI run of this repository's own commit. */
  async function ciResult(sha: string): Promise<CiResult> {
    const body = record(
      await get("actions.runs", `/actions/runs?head_sha=${sha}&per_page=${PAGE}`),
    );
    if (!Array.isArray(body.workflow_runs)) {
      throw new Error("GitHub actions.runs returned an unexpected reply");
    }
    const runs = body.workflow_runs
      .map(record)
      .filter(
        (run) =>
          run.name === CI_WORKFLOW &&
          text(record(run.head_repository).full_name).toLowerCase() === repo.toLowerCase() &&
          // A cancelled or skipped run says nothing about the commit.
          !["cancelled", "skipped", "stale"].includes(text(run.conclusion)),
      )
      .sort((a, b) => time(b.created_at) - time(a.created_at));
    const latest = runs[0];
    if (!latest) return "none";
    if (latest.status !== "completed") return "pending";
    return ["success", "neutral"].includes(text(latest.conclusion)) ? "success" : "failure";
  }

  /**
   * The newest automated review verdict the workflow bot posted for one
   * commit. Only unedited comments count, as in the reviewer itself.
   */
  async function reviewResult(pullNumber: number, sha: string): Promise<ReviewResult> {
    const verdicts = (await list("issues.listComments", `/issues/${pullNumber}/comments`))
      .filter((comment) => {
        const user = record(comment.user);
        return (
          user.login === AGENT_LOGIN &&
          user.id === AGENT_ID &&
          text(comment.updated_at) === text(comment.created_at)
        );
      })
      .flatMap((comment) => {
        const match = REVIEW_MARKER.exec(text(comment.body));
        return match && match[2] === sha
          ? [{ result: match[1] as ReviewResult, at: time(comment.created_at) }]
          : [];
      })
      .sort((a, b) => b.at - a.at);
    return verdicts[0]?.result ?? "none";
  }

  /**
   * The last time approval was applied before the pull request opened, or null
   * when unknown (including an event history too long to read safely).
   */
  async function approvalTime(number: number, openedAt: string): Promise<string | null> {
    const opened = Date.parse(openedAt);
    let events: Raw[];
    try {
      events = await list("issues.events", `/issues/${number}/events`);
    } catch (error) {
      if (error instanceof TooBusy) return null;
      throw error;
    }
    const approvals = events
      .filter(
        (event) =>
          event.event === "labeled" &&
          record(event.label).name === APPROVAL_LABEL &&
          time(event.created_at) <= opened,
      )
      .sort((a, b) => time(b.created_at) - time(a.created_at));
    return approvals[0] ? text(approvals[0].created_at) : null;
  }

  async function readRequest(issue: RequestIssue): Promise<RequestFacts> {
    const { number } = issue;
    const empty: RequestFacts = {
      number,
      createdAt: issue.createdAt,
      approvedAt: null,
      hasPull: false,
      previewReadyAt: null,
      previewSha: null,
      commits: [],
      firstCi: "none",
      firstReview: "none",
    };
    const branch = `request-${number}`;
    const pulls = await get("pulls.list", `/pulls?head=${owner}:${branch}&state=all&per_page=10`);
    if (!Array.isArray(pulls)) throw new Error("GitHub pulls.list returned a non-list");
    const pull = pulls.map(record).find((candidate) => {
      const head = record(candidate.head);
      const author = record(candidate.user);
      return (
        head.ref === branch &&
        text(record(head.repo).full_name).toLowerCase() === repo.toLowerCase() &&
        text(author.type) === "Bot" &&
        sameLogin(author.login, agentAppLogin)
      );
    });
    if (!pull) return empty;

    const pullNumber = Number(pull.number);
    const commits: CommitFact[] = (await list("pulls.commits", `/pulls/${pullNumber}/commits`))
      .filter((commit) => SHA.test(text(commit.sha)))
      .map((commit) => {
        const login = record(commit.author).login;
        return { sha: text(commit.sha), authorLogin: typeof login === "string" ? login : null };
      });
    if (commits.length === 0) return { ...empty, hasPull: true };

    const firstSha = commits[0].sha;
    const preview = await firstPreview(branch, new Set(commits.map((commit) => commit.sha)));
    return {
      ...empty,
      approvedAt: await approvalTime(number, text(pull.created_at)),
      hasPull: true,
      previewReadyAt: preview?.readyAt ?? null,
      previewSha: preview?.sha ?? null,
      commits,
      firstCi: await ciResult(firstSha),
      firstReview: await reviewResult(pullNumber, firstSha),
    };
  }

  const requests: RequestFacts[] = [];
  let unreadable = 0;
  let tooBusy = 0;
  let stoppedEarly = false;
  const { issues, truncated } = await listRequestIssues();
  for (const issue of issues) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      stoppedEarly = true;
      break;
    }
    try {
      requests.push(await readRequest(issue));
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        stoppedEarly = true;
        break;
      }
      // Bad credentials or rate limiting would fail every request the same way.
      if (error instanceof GitHubApiError && [401, 403, 429].includes(error.status)) throw error;
      if (error instanceof TooBusy) tooBusy += 1;
      else unreadable += 1;
      log(
        `Request ${issue.number} could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  return { requests, unreadable, tooBusy, stoppedEarly, truncated };
}
