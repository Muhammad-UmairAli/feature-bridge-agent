/**
 * The write-scope check for pull requests. It runs from the base branch's code
 * (never the pull request's) and reads the pull request's commits as data.
 *
 * - Request branches (`request-<number>`) must come from this repository, from
 *   the coding agent, into `main`, and may only add or change allowed files in
 *   a new `src/app/demos/request-<number>/` folder: every path in every commit
 *   (deletions and both sides of renames included), regular files only, no
 *   merges, size-limited strict UTF-8 text without invisible characters or
 *   lint/type-check suppressions.
 * - The coding agent may not use any other branch; other pull requests pass.
 */
import { demoSlug } from "../planner/request.mts";
import { isAllowedDemoPath } from "../planner/scope.mts";

const BRANCH = /^request-([1-9]\d{0,9})$/;
const SHA = /^[0-9a-f]{40}$/;

/** The demo folder a `request-<number>` branch may write to, or null for other branches. */
export function slugForBranch(branch: string): string | null {
  const match = BRANCH.exec(branch);
  return match ? demoSlug(Number(match[1])) : null;
}

export const isSha = (value: string) => SHA.test(value);

/**
 * A second, deliberately separate statement of the allowed paths, so a change
 * to the shared rule (used when publishing) can't loosen this backstop too.
 */
const SECOND_OPINION =
  /^src\/app\/demos\/request-[1-9]\d{0,9}\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\.test)?\.tsx?$/;

export interface RawChange {
  oldMode: string;
  newMode: string;
  /** Full id of the new blob (all zeros for deletions). */
  newBlob: string;
  status: string;
  path: string;
}

/**
 * Parse `git log --raw -z --no-abbrev --no-renames --format=` output: for each
 * change, ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0".
 */
export function parseRawLog(output: string): RawChange[] {
  const fields = output.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const header = fields[i].replace(/^\n+/, "");
    if (!header) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*$/.exec(header);
    if (!match) throw new Error("unexpected git log output");
    const path = fields[i + 1];
    if (path === undefined) throw new Error("unexpected git log output");
    changes.push({
      oldMode: match[1],
      newMode: match[2],
      newBlob: match[3],
      status: match[4],
      path,
    });
    i += 1;
  }
  return changes;
}

/** A path made safe for one-line log annotations: printable ASCII only, `%` escaped. */
export function shown(path: string): string {
  const escaped = path.replace(
    /[^\x20-\x7e]|%/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return JSON.stringify(escaped);
}

const REGULAR_FILE = "100644";
const ABSENT = "000000";

/** Problems with the changed paths and file types. */
export function checkChanges(changes: RawChange[], slug: string): string[] {
  const problems: string[] = [];
  for (const change of changes) {
    const where = shown(change.path);
    if (!isAllowedDemoPath(change.path, slug) || !SECOND_OPINION.test(change.path)) {
      problems.push(`${where}: outside src/app/demos/${slug}/ or not an allowed demo file`);
      continue;
    }
    if (!["A", "M", "D"].includes(change.status)) {
      problems.push(`${where}: unsupported change type ${change.status}`);
    }
    // New and modified files must be plain, non-executable files; deletions
    // must remove one. Anything else is a symlink, submodule or mode change.
    const expectedOld = change.status === "A" ? ABSENT : REGULAR_FILE;
    const expectedNew = change.status === "D" ? ABSENT : REGULAR_FILE;
    if (change.oldMode !== expectedOld || change.newMode !== expectedNew) {
      problems.push(
        `${where}: only regular files are allowed (mode ${change.oldMode} -> ${change.newMode})`,
      );
    }
  }
  return problems;
}

export const MAX_FILE_BYTES = 100_000;
export const MAX_TOTAL_BYTES = 1_000_000;

/** Characters that change how code reads without showing: controls, bidi, zero-width, BOM. */
const INVISIBLE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
/** Comments that switch checks off. */
const SUPPRESSION =
  /eslint-disable|eslint-enable|\/\*\s*eslint\s|@ts-(?:ignore|nocheck|expect-error)/;

/** Problems with one file's content (the bytes of a blob added or changed by the pull request). */
export function checkContent(path: string, bytes: Uint8Array): string[] {
  const where = shown(path);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return [`${where}: larger than ${MAX_FILE_BYTES} bytes`];
  }
  let text: string;
  try {
    // ignoreBOM keeps a leading byte-order mark in the text, so it is caught below.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return [`${where}: not valid UTF-8 text`];
  }
  const problems: string[] = [];
  if (INVISIBLE.test(text)) problems.push(`${where}: contains control or invisible characters`);
  if (SUPPRESSION.test(text)) problems.push(`${where}: contains a lint or type-check suppression`);
  return problems;
}

/** The pull request facts the check needs, all taken from the event (never from the branch's files). */
export interface PullRequestInfo {
  headRef: string;
  headRepo: string;
  baseRepo: string;
  baseRef: string;
  author: string;
  /** The coding agent's bot login (repository variable); empty if not configured. */
  agentLogin: string;
}

export type Classification =
  { kind: "request"; slug: string } | { kind: "other" } | { kind: "refused"; problems: string[] };

/** Which rules apply to this pull request, and whether its shape is allowed at all. */
export function classify(pr: PullRequestInfo): Classification {
  const byAgent = pr.agentLogin !== "" && pr.author.toLowerCase() === pr.agentLogin.toLowerCase();
  const looksLikeRequest = /^request-/i.test(pr.headRef);
  if (!looksLikeRequest) {
    return byAgent
      ? {
          kind: "refused",
          problems: ["the coding agent may only open pull requests from request-<number> branches"],
        }
      : { kind: "other" };
  }
  const problems: string[] = [];
  const slug = slugForBranch(pr.headRef);
  if (!slug) problems.push("request branches must be named exactly request-<number>");
  if (pr.headRepo !== pr.baseRepo) problems.push("request branches must come from this repository");
  if (pr.baseRef !== "main") problems.push("request pull requests must target main");
  if (!pr.agentLogin)
    problems.push("AGENT_APP_LOGIN isn't configured, so request pull requests can't be checked");
  else if (!byAgent) problems.push("request pull requests must be opened by the coding agent");
  return problems.length > 0 || !slug ? { kind: "refused", problems } : { kind: "request", slug };
}
