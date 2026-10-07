/**
 * Reads a request's status from GitHub for the tracking page, with read-only
 * access. Only issues created by the portal (bot author + request label)
 * resolve; everything else reads as "not found".
 *
 * The linked pull request is found by convention, not by mentions: the coding
 * agent builds request N on branch `request-N` in this repository. Looking up
 * `head=<owner>:request-N` excludes forks, and the PR must also be bot-authored
 * from this repository, so outsiders can't change what the page shows.
 *
 * Each page view costs at most 4 GitHub calls. Concurrent views of the same id
 * share one lookup, results are cached (not-found results for longer), and a
 * short circuit breaker pauses lookups after rate limiting or an outage, so
 * anonymous browsing can't exhaust the App's rate limit that submissions use.
 */
import type { GitHubAppConfig } from "@/lib/config";
import { log } from "@/lib/log";
import { LABELS } from "@/lib/requests/labels";
import { type RequestStatus, deriveStatus } from "@/lib/requests/status";

import { GitHubError, githubRequest } from "./api";
import { type InstallationPermissions, getInstallationToken } from "./app-auth";

const READ_PERMISSIONS: InstallationPermissions = {
  issues: "read",
  pull_requests: "read",
  deployments: "read",
};
const FOUND_TTL_MS = 30_000;
const NOT_FOUND_TTL_MS = 10 * 60_000;
/** After a rate limit or outage, stop calling GitHub from this page for a while. */
const BREAKER_PAUSE_MS = 60_000;
/** Bounded, so requests for many ids can't grow memory without limit. */
const CACHE_MAX_ENTRIES = 500;
/** The preview link is optional; never let it hold the page up for long. */
const PREVIEW_BUDGET_MS = 3000;
/** Hosts preview deployments may live on (comma-separated suffixes). */
const DEFAULT_PREVIEW_HOST_SUFFIXES = ".vercel.app";

/** Branch the coding agent uses for a request; the tracking page relies on it. */
export const requestBranch = (id: number) => `request-${id}`;

export interface RequestView {
  id: number;
  title: string;
  status: RequestStatus;
  createdAt: string;
  issueUrl: string;
  pullRequest: { number: number; url: string } | null;
  previewUrl: string | null;
}

interface Issue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
  user?: { type?: unknown } | null;
  labels?: unknown;
}

interface Pull {
  number?: unknown;
  state?: unknown;
  html_url?: unknown;
  merged_at?: unknown;
  user?: { type?: unknown } | null;
  head?: { sha?: unknown; repo?: { full_name?: unknown } | null } | null;
}

type Cached = { expiresAtMs: number; result: Promise<RequestView | null> };
const cache = new Map<number, Cached>();
let pausedUntilMs = 0;

/** Test hook. */
export function clearRequestStatusCache(): void {
  cache.clear();
  pausedUntilMs = 0;
}

const unavailable = () => new GitHubError(0, true);

const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels)
    ? labels
        .map((label) =>
          typeof label === "string" ? label : (label as { name?: unknown } | null)?.name,
        )
        .filter((name): name is string => typeof name === "string")
    : [];

/** A github.com URL inside the target repository, or "". */
function repoUrl(value: unknown, config: GitHubAppConfig): string {
  const prefix = `https://github.com/${config.owner}/${config.repo}/`;
  return typeof value === "string" && value.startsWith(prefix) ? value : "";
}

/** A plain https URL on an allowed preview host, or null. */
export function safePreviewUrl(value: unknown, hostSuffixes: string[]): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return hostSuffixes.some((suffix) => url.hostname.endsWith(suffix)) ? url.href : null;
  } catch {
    return null;
  }
}

/** The agent's PR for this request: newest on branch request-<id>, bot-authored, from this repo. */
async function findPull(
  config: GitHubAppConfig,
  token: string,
  id: number,
  fetchImpl?: typeof fetch,
) {
  const query = new URLSearchParams({
    head: `${config.owner}:${requestBranch(id)}`,
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: "1",
  });
  const pulls = await githubRequest<Pull[]>(
    `/repos/${config.owner}/${config.repo}/pulls?${query}`,
    {
      auth: token,
      operation: "pulls.find_for_request",
      fetchImpl,
    },
  );
  const pull = Array.isArray(pulls) ? pulls[0] : undefined;
  if (
    !pull ||
    typeof pull.number !== "number" ||
    pull.user?.type !== "Bot" ||
    pull.head?.repo?.full_name !== `${config.owner}/${config.repo}`
  ) {
    return null;
  }
  return {
    number: pull.number,
    url: repoUrl(pull.html_url, config),
    state: pull.state === "open" ? ("open" as const) : ("closed" as const),
    merged: typeof pull.merged_at === "string",
    sha:
      typeof pull.head?.sha === "string" && /^[0-9a-f]{40}$/.test(pull.head.sha)
        ? pull.head.sha
        : null,
  };
}

/** Newest non-production, bot-created deployment for the commit, if its newest status succeeded. */
async function findPreviewUrl(
  config: GitHubAppConfig,
  token: string,
  sha: string,
  hostSuffixes: string[],
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  const repo = `/repos/${config.owner}/${config.repo}`;
  const deployments = await githubRequest<
    { id?: unknown; production_environment?: unknown; creator?: { type?: unknown } | null }[]
  >(`${repo}/deployments?sha=${sha}&per_page=1`, {
    auth: token,
    operation: "deployments.list",
    fetchImpl,
  });
  const deployment = Array.isArray(deployments) ? deployments[0] : undefined;
  if (
    !deployment ||
    typeof deployment.id !== "number" ||
    deployment.production_environment === true ||
    deployment.creator?.type !== "Bot"
  ) {
    return null;
  }
  const statuses = await githubRequest<{ state?: unknown; environment_url?: unknown }[]>(
    `${repo}/deployments/${deployment.id}/statuses?per_page=1`,
    { auth: token, operation: "deployments.statuses", fetchImpl },
  );
  const latest = Array.isArray(statuses) ? statuses[0] : undefined;
  return latest?.state === "success" ? safePreviewUrl(latest.environment_url, hostSuffixes) : null;
}

/** Best effort within a time budget; any failure just means "no preview link". */
async function previewWithinBudget(lookup: () => Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PREVIEW_BUDGET_MS);
  });
  try {
    return await Promise.race([lookup(), timeout]);
  } catch (error) {
    log.warn("request_status.preview_lookup_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadRequest(
  config: GitHubAppConfig,
  id: number,
  previewHostSuffixes: string[],
  fetchImpl?: typeof fetch,
): Promise<RequestView | null> {
  const token = await getInstallationToken(config, READ_PERMISSIONS, { fetchImpl });
  let issue: Issue;
  try {
    issue = await githubRequest<Issue>(`/repos/${config.owner}/${config.repo}/issues/${id}`, {
      auth: token,
      operation: "issues.get",
      fetchImpl,
    });
  } catch (error) {
    // 404 and 410 (deleted) simply mean "no such request".
    if (
      error instanceof GitHubError &&
      (error.upstreamStatus === 404 || error.upstreamStatus === 410)
    )
      return null;
    throw error;
  }
  const labels = labelNames(issue.labels);
  const issueUrl = repoUrl(issue.html_url, config);
  const isPortalRequest =
    issue.number === id &&
    issue.pull_request === undefined &&
    issue.user?.type === "Bot" &&
    labels.includes(LABELS.portalRequest) &&
    issueUrl !== "";
  if (!isPortalRequest) return null;

  const pull = await findPull(config, token, id, fetchImpl);
  const previewUrl =
    pull?.state === "open" && pull.sha
      ? await previewWithinBudget(() =>
          findPreviewUrl(config, token, pull.sha!, previewHostSuffixes, fetchImpl),
        )
      : null;

  return {
    id,
    title: typeof issue.title === "string" ? issue.title : `Request #${id}`,
    status: deriveStatus({
      issueState: issue.state === "closed" ? "closed" : "open",
      labels,
      pullRequest: pull,
      previewUrl,
    }),
    createdAt: typeof issue.created_at === "string" ? issue.created_at : "",
    issueUrl,
    pullRequest: pull && pull.url ? { number: pull.number, url: pull.url } : null,
    previewUrl,
  };
}

export async function getRequestStatus(
  config: GitHubAppConfig,
  id: number,
  options: { fetchImpl?: typeof fetch; nowMs?: number; previewHostSuffixes?: string[] } = {},
): Promise<RequestView | null> {
  const nowMs = options.nowMs ?? Date.now();
  const cached = cache.get(id);
  if (cached && cached.expiresAtMs > nowMs) return cached.result;
  if (nowMs < pausedUntilMs) throw unavailable();

  const suffixes =
    options.previewHostSuffixes ??
    (process.env.PREVIEW_HOST_SUFFIXES ?? DEFAULT_PREVIEW_HOST_SUFFIXES)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const result = loadRequest(config, id, suffixes, options.fetchImpl);
  const entry: Cached = { expiresAtMs: nowMs + FOUND_TTL_MS, result };

  cache.delete(id);
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as number); // oldest first
  cache.set(id, entry); // concurrent views of this id share the same lookup

  try {
    const view = await result;
    if (view === null) entry.expiresAtMs = nowMs + NOT_FOUND_TTL_MS;
    return view;
  } catch (error) {
    if (cache.get(id) === entry) cache.delete(id);
    // Rate limits and outages trip the breaker; don't keep calling GitHub.
    if (error instanceof GitHubError && error.status === 503)
      pausedUntilMs = nowMs + BREAKER_PAUSE_MS;
    throw error;
  }
}
