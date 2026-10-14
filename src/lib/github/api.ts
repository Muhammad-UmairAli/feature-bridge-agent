/**
 * Minimal GitHub REST client: fixed base URL and headers, no redirects, a
 * timeout on every call, and failures mapped to HttpErrors. Only the
 * operation, status and GitHub's request id are logged: never tokens, request
 * bodies or response bodies.
 */
import { HttpError } from "@/lib/api/envelope";
import { log } from "@/lib/log";

export const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

export interface GitHubRequest {
  method?: "GET" | "POST";
  /** Bearer credential: an app JWT or an installation token. */
  auth: string;
  body?: unknown;
  /** Short operation name for logs, e.g. "issues.create". */
  operation: string;
  fetchImpl?: typeof fetch;
}

/** A failed GitHub call; `status` is GitHub's HTTP status (0 when unreachable). */
export class GitHubError extends HttpError {
  readonly upstreamStatus: number;

  constructor(upstreamStatus: number, transient: boolean) {
    super(
      transient ? 503 : 502,
      transient ? "SERVICE_UNAVAILABLE" : "UPSTREAM_ERROR",
      transient
        ? "GitHub is unavailable right now. Please try again later."
        : "We couldn't reach GitHub correctly. Please try again later.",
    );
    this.upstreamStatus = upstreamStatus;
  }
}

/** Primary/secondary rate limits arrive as 429 or as 403 with these headers. */
function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  return (
    response.status === 403 &&
    (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0")
  );
}

export async function githubRequest<T>(path: string, request: GitHubRequest): Promise<T> {
  const { method = "GET", auth, body, operation, fetchImpl = fetch } = request;
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "feature-bridge-agent",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout can still mean GitHub completed the call (e.g. created an issue).
    log.error("github.unreachable", {
      operation,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new GitHubError(0, true);
  }

  const githubRequestId = response.headers.get("x-github-request-id");
  if (!response.ok) {
    await response.body?.cancel();
    log.error("github.http_error", { operation, status: response.status, githubRequestId });
    throw new GitHubError(response.status, response.status >= 500 || isRateLimited(response));
  }

  try {
    return (await response.json()) as T;
  } catch {
    log.error("github.malformed_response", { operation, githubRequestId });
    throw new GitHubError(response.status, false);
  }
}
