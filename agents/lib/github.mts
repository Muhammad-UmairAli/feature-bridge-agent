/**
 * The agents' GitHub access: a few REST calls on one repository with the
 * workflow's token. Errors carry the operation and status only, never
 * response bodies or the token.
 */
const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`GitHub ${operation} failed with ${status}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

/** The account shape GitHub uses for issue and comment authors. */
export interface Account {
  login: string;
  id: number;
  type: string;
}

export interface Issue {
  number: number;
  state: string;
  body: string;
  user: Account | null;
  labels: string[];
  isPullRequest: boolean;
}

export interface Comment {
  id: number;
  body: string;
  user: Account | null;
  createdAt: string;
  updatedAt: string;
}

/** The latest time a label was added, and by whom. */
export interface LabelEvent {
  actor: Account | null;
  createdAt: string;
}

export interface GitHubClient {
  getIssue(number: number): Promise<Issue>;
  listComments(number: number): Promise<Comment[]>;
  createComment(number: number, body: string): Promise<void>;
  addLabels(number: number, labels: string[]): Promise<void>;
  /** Removing a label that isn't there is not an error. */
  removeLabel(number: number, label: string): Promise<void>;
  /** The account's role on the repository (`admin`, `maintain`, `write`, `triage`, `read`), or "" if none. */
  getRole(login: string): Promise<string>;
  /** The most recent time `label` was added to the issue, or null if never. */
  latestLabelEvent(number: number, label: string): Promise<LabelEvent | null>;
}

type Raw = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

function account(value: unknown): Account | null {
  const raw = value as Raw | null | undefined;
  return raw && typeof raw.login === "string" && typeof raw.id === "number"
    ? { login: raw.login, id: raw.id, type: text(raw.type) }
    : null;
}

const labelNames = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((label) => (label as Raw | null)?.name)
        .filter((name): name is string => typeof name === "string")
    : [];

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function createGitHubClient(
  repo: string,
  token: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): GitHubClient {
  if (!REPO.test(repo)) throw new Error("GITHUB_REPOSITORY must look like owner/name");

  /**
   * One REST call. Idempotent calls (reads, label changes) are retried once on
   * a network error or 502/503/504; posting a comment is not, so it can't be
   * doubled. Failures carry the operation and status only (0 for network).
   */
  async function call(
    operation: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
    allow: number[] = [],
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const attempts = operation === "issues.createComment" ? 1 : 2;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${API}/repos/${repo}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "feature-bridge-agent",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // A fresh error: fetch's own can echo request details.
        if (attempt < attempts) continue;
        throw new GitHubApiError(operation, 0);
      }
      if (response.ok || allow.includes(response.status)) return response;
      await response.body?.cancel().catch(() => {});
      if (attempt < attempts && [502, 503, 504].includes(response.status)) continue;
      throw new GitHubApiError(operation, response.status);
    }
  }

  const done = async (response: Response) => {
    await response.body?.cancel().catch(() => {});
  };

  return {
    async getIssue(number) {
      const raw = (await (await call("issues.get", `/issues/${number}`)).json()) as Raw;
      return {
        number: typeof raw.number === "number" ? raw.number : number,
        state: text(raw.state),
        body: text(raw.body),
        user: account(raw.user),
        labels: labelNames(raw.labels),
        isPullRequest: raw.pull_request !== undefined,
      };
    },

    async listComments(number) {
      const comments: Comment[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = (await (
          await call("issues.listComments", `/issues/${number}/comments?per_page=100&page=${page}`)
        ).json()) as unknown;
        if (!Array.isArray(batch)) throw new Error("GitHub returned a non-list");
        for (const item of batch as Raw[]) {
          if (typeof item.id !== "number") continue;
          comments.push({
            id: item.id,
            body: text(item.body),
            user: account(item.user),
            createdAt: text(item.created_at),
            updatedAt: text(item.updated_at),
          });
        }
        if (batch.length < 100) return comments;
      }
      throw new Error("too many comments to read safely");
    },

    async createComment(number, body) {
      await done(
        await call("issues.createComment", `/issues/${number}/comments`, {
          method: "POST",
          body: { body },
        }),
      );
    },

    async addLabels(number, labels) {
      await done(
        await call("issues.addLabels", `/issues/${number}/labels`, {
          method: "POST",
          body: { labels },
        }),
      );
    },

    async latestLabelEvent(number, label) {
      let latest: LabelEvent | null = null;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = (await (
          await call("issues.listEvents", `/issues/${number}/events?per_page=100&page=${page}`)
        ).json()) as unknown;
        if (!Array.isArray(batch)) throw new Error("GitHub returned a non-list");
        for (const item of batch as Raw[]) {
          const name = (item.label as Raw | null | undefined)?.name;
          if (item.event === "labeled" && name === label) {
            latest = { actor: account(item.actor), createdAt: text(item.created_at) };
          }
        }
        if (batch.length < 100) return latest;
      }
      throw new Error("too many events to read safely");
    },

    async getRole(login) {
      if (!LOGIN.test(login)) return "";
      const response = await call(
        "repos.getCollaboratorPermission",
        `/collaborators/${login}/permission`,
        {},
        [404],
      );
      if (response.status === 404) {
        await done(response);
        return "";
      }
      const raw = (await response.json()) as Raw;
      return text(raw.role_name);
    },

    async removeLabel(number, label) {
      await done(
        await call(
          "issues.removeLabel",
          `/issues/${number}/labels/${encodeURIComponent(label)}`,
          { method: "DELETE" },
          [404],
        ),
      );
    },
  };
}
