/**
 * The cleanup job's GitHub access, using the workflow's GITHUB_TOKEN (issues:
 * write in this repository only). Logs nothing about content.
 */
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 50;

export interface IssueSummary {
  number: number;
  body: string;
  authorLogin: string;
  authorType: string;
  labels: string[];
}

async function call(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "feature-bridge-agent-cleanup",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub ${init.method ?? "GET"} failed with ${response.status}`);
  }
  return response;
}

type RawIssue = {
  number?: unknown;
  body?: unknown;
  pull_request?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
  labels?: unknown;
};

const summarise = (item: RawIssue): IssueSummary | null =>
  typeof item.number === "number" && item.pull_request === undefined
    ? {
        number: item.number,
        body: typeof item.body === "string" ? item.body : "",
        authorLogin: typeof item.user?.login === "string" ? item.user.login : "",
        authorType: typeof item.user?.type === "string" ? item.user.type : "",
        labels: Array.isArray(item.labels)
          ? item.labels
              .map((label) => (label as { name?: unknown } | null)?.name)
              .filter((name): name is string => typeof name === "string")
          : [],
      }
    : null;

/** Every issue (any label, open or closed) updated since `sinceIso`. */
export async function listIssuesSince(
  repo: string,
  token: string,
  sinceIso: string,
): Promise<IssueSummary[]> {
  const issues: IssueSummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      state: "all",
      since: sinceIso,
      per_page: "100",
      page: String(page),
    });
    const batch = (await (
      await call(`/repos/${repo}/issues?${query}`, token)
    ).json()) as RawIssue[];
    if (!Array.isArray(batch)) throw new Error("GitHub returned a non-list");
    for (const item of batch) {
      const summary = summarise(item);
      if (summary) issues.push(summary);
    }
    if (batch.length < 100) return issues;
  }
  throw new Error("too many issues to scan safely");
}

export async function getIssueBody(repo: string, token: string, number: number): Promise<string> {
  const issue = (await (await call(`/repos/${repo}/issues/${number}`, token)).json()) as RawIssue;
  return typeof issue.body === "string" ? issue.body : "";
}

export async function updateIssueBody(
  repo: string,
  token: string,
  number: number,
  body: string,
): Promise<void> {
  await call(`/repos/${repo}/issues/${number}`, token, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}
