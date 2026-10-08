/**
 * Publishing a generated demo: one commit with exactly the validated files on
 * branch `request-<number>` from `main`, through the Git Data API (no git
 * credentials on the runner), and a pull request into `main` with fixed text.
 * Uses the coding agent App's token, so CI and previews run on the pull
 * request (pushes made with the workflow's own token wouldn't trigger them).
 *
 * The files are checked again here (this is the last step before anything is
 * public). Nothing is ever force-updated or deleted: an existing branch, pull
 * request or demo stops the run. Within a run, a lost response is recovered by
 * looking again (the branch points at this exact commit; the pull request is
 * listed); otherwise a maintainer takes over.
 */
import { GitHubApiError } from "../lib/github.mts";
import { type GeneratedFile, validateFiles } from "./files.mts";
import { LOADER_FILE, PAGE_FILE, loaderTemplate, templateTitle } from "./template.mts";

const API = "https://api.github.com";
const TIMEOUT_MS = 30_000;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export interface PublishInput {
  /** owner/name */
  repo: string;
  issueNumber: number;
  slug: string;
  files: GeneratedFile[];
}

export interface Published {
  branch: string;
  commitSha: string;
  pullNumber: number;
  pullUrl: string;
}

export class PublishRefused extends Error {
  readonly reason: "branch_exists" | "pull_exists" | "folder_exists" | "invalid_files";
  readonly problems: string[];

  constructor(reason: PublishRefused["reason"], problems: string[] = []) {
    super(`publishing refused: ${reason}`);
    this.name = "PublishRefused";
    this.reason = reason;
    this.problems = problems;
  }
}

/** The branch was created but the pull request wasn't: a maintainer opens or removes it. */
export class PublishIncomplete extends Error {
  readonly branch: string;

  constructor(branch: string) {
    super("the branch was pushed but the pull request couldn't be opened");
    this.name = "PublishIncomplete";
    this.branch = branch;
  }
}

type Fetch = typeof fetch;

/** Fixed commit and pull request text: nothing from the model or the request. */
export const commitMessage = (issueNumber: number) =>
  `feat(demos): build request #${issueNumber}\n\nBuilt by the coding agent from the approved plan.`;
export const pullTitle = (issueNumber: number) => `Demo for request #${issueNumber}`;
export const pullBody = (issueNumber: number, slug: string) =>
  [
    `Builds the approved plan for #${issueNumber} in \`src/app/demos/${slug}/\`.`,
    "",
    "Written by the coding agent. Review the code before merging: it is generated from a public request. CI runs the tests, lint and the write-scope check; an automated review follows.",
    "",
    `Closes #${issueNumber}`,
  ].join("\n");

/** The same checks the files passed when generated, repeated at the write boundary. */
export function publishProblems(input: PublishInput): string[] {
  const { issueNumber, slug, files } = input;
  if (!REPO.test(input.repo) || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    return ["invalid repository or request number"];
  }
  if (slug !== `request-${issueNumber}`) return ["the demo folder doesn't match the request"];
  const dir = `src/app/demos/${slug}/`;
  const page = files.filter((file) => file.path === `${dir}${PAGE_FILE}`);
  const loader = files.filter((file) => file.path === `${dir}${LOADER_FILE}`);
  const model = files.filter((file) => file !== page[0] && file !== loader[0]);
  const problems = validateFiles(model, slug);
  if (page.length !== 1 || templateTitle(page[0].content) === null) {
    problems.push("the page isn't the workflow's template");
  }
  if (loader.length !== 1 || loader[0].content !== loaderTemplate()) {
    problems.push("the loader isn't the workflow's template");
  }
  return problems;
}

export async function publishDemo(
  token: string,
  input: PublishInput,
  fetchImpl: Fetch = (...args) => fetch(...args),
): Promise<Published> {
  const problems = publishProblems(input);
  if (problems.length > 0) throw new PublishRefused("invalid_files", problems);
  const { repo, issueNumber, slug, files } = input;
  const branch = slug;

  async function call(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<{ status: number; data: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${API}/repos/${repo}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "feature-bridge-agent",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GitHubApiError(operation, 0);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (allow.includes(response.status)) return { status: response.status, data: null };
      throw new GitHubApiError(operation, response.status);
    }
    try {
      return { status: response.status, data: await response.json() };
    } catch {
      throw new GitHubApiError(operation, 0);
    }
  }
  const get = (value: unknown, ...keys: string[]) =>
    keys.reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
  const sha = (value: unknown, operation: string) => {
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
      throw new GitHubApiError(operation, 0);
    return value;
  };
  const owner = repo.split("/")[0];
  const findPull = async () => {
    const { data } = await call(
      "pulls.list",
      "GET",
      `/pulls?state=all&head=${owner}:${branch}&per_page=1`,
    );
    const pull = Array.isArray(data) ? data[0] : undefined;
    const number = get(pull, "number");
    const url = get(pull, "html_url");
    return typeof number === "number" && typeof url === "string" ? { number, url } : null;
  };

  // One build per request: never touch an existing branch, pull request or demo.
  const existing = await call(
    "git.getBranchRef",
    "GET",
    `/git/ref/heads/${branch}`,
    undefined,
    [404],
  );
  if (existing.status !== 404) throw new PublishRefused("branch_exists");
  if (await findPull()) throw new PublishRefused("pull_exists");

  const mainRef = await call("git.getMainRef", "GET", "/git/ref/heads/main");
  const baseSha = sha(get(mainRef.data, "object", "sha"), "git.getMainRef");
  const folder = await call(
    "repos.getContent",
    "GET",
    `/contents/src/app/demos/${slug}?ref=${baseSha}`,
    undefined,
    [404],
  );
  if (folder.status !== 404) throw new PublishRefused("folder_exists");
  const baseCommit = await call("git.getCommit", "GET", `/git/commits/${baseSha}`);
  const baseTree = sha(get(baseCommit.data, "tree", "sha"), "git.getCommit");

  const tree = await call("git.createTree", "POST", "/git/trees", {
    base_tree: baseTree,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.content,
    })),
  });
  const commit = await call("git.createCommit", "POST", "/git/commits", {
    message: commitMessage(issueNumber),
    tree: sha(get(tree.data, "sha"), "git.createTree"),
    parents: [baseSha],
  });
  const commitSha = sha(get(commit.data, "sha"), "git.createCommit");

  try {
    await call("git.createRef", "POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  } catch (error) {
    // Another run won the race, or this response was lost after the ref was made.
    const ref = await call("git.getBranchRef", "GET", `/git/ref/heads/${branch}`, undefined, [404]);
    const at = get(ref.data, "object", "sha");
    if (ref.status === 404) throw error;
    if (at !== commitSha) throw new PublishRefused("branch_exists");
  }

  try {
    const pull = await call("pulls.create", "POST", "/pulls", {
      title: pullTitle(issueNumber),
      head: branch,
      base: "main",
      body: pullBody(issueNumber, slug),
      maintainer_can_modify: false,
    });
    const pullNumber = get(pull.data, "number");
    const pullUrl = get(pull.data, "html_url");
    if (typeof pullNumber !== "number" || typeof pullUrl !== "string") {
      throw new GitHubApiError("pulls.create", 0);
    }
    return { branch, commitSha, pullNumber, pullUrl };
  } catch {
    // The pull request may exist even if its response was lost.
    const found = await findPull().catch(() => null);
    if (found) return { branch, commitSha, pullNumber: found.number, pullUrl: found.url };
    throw new PublishIncomplete(branch);
  }
}
