/**
 * Who may approve, request changes or otherwise steer the agents: the GitHub
 * usernames in the APPROVER_ALLOWLIST repository variable. Each fork sets its
 * own; a missing or empty list allows nobody.
 *
 * The same list governs approvals, plan feedback and pull request reviews.
 * Callers pass the account object GitHub put in the event payload (`sender`
 * for label events, `comment.user`, `review.user`), never a name taken from
 * text or `github.actor`. This check is necessary but not sufficient: usernames
 * can be freed and re-registered, so every caller (labels, comments, reviews)
 * also confirms the account still has a role in STEERING_ROLES, and the
 * self-approval rule (approver isn't the issue author) is theirs to apply.
 */

/**
 * GitHub's username rules: ASCII letters and digits with single inner hyphens,
 * at most 39 characters. Deliberately no `i`, `u` or `v` flag: with Unicode case
 * folding, look-alikes such as the Kelvin sign would match `k`. Older accounts
 * whose names break today's rules can't be listed; that fails closed.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** GitHub's placeholder for deleted accounts: content from anyone can end up under it. */
const RESERVED = new Set(["ghost"]);

export interface Allowlist {
  logins: ReadonlySet<string>;
  /** Entries dropped as invalid; log the count, not the values, so typos are diagnosable. */
  rejected: number;
}

/**
 * Parse the variable: comma or whitespace separated usernames, an optional
 * leading `@` each. Entries that aren't valid usernames (including any
 * `name[bot]` account) or are reserved are dropped, so they can never match.
 */
export function parseAllowlist(raw: string | undefined): Allowlist {
  const logins = new Set<string>();
  let rejected = 0;
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    const login = entry.replace(/^@/, "");
    // Validate before lowercasing: toLowerCase maps some non-ASCII look-alikes
    // (the Kelvin sign) to ASCII letters.
    if (LOGIN.test(login) && !RESERVED.has(login.toLowerCase())) logins.add(login.toLowerCase());
    else rejected += 1;
  }
  return { logins, rejected };
}

type Env = Record<string, string | undefined>;

/** The allowlist from the APPROVER_ALLOWLIST variable. */
export function readAllowlist(env: Env = process.env): Allowlist {
  return parseAllowlist(env.APPROVER_ALLOWLIST);
}

/** The login/type pair GitHub sends as `sender`, `comment.user` and `review.user`. */
export interface GitHubAccount {
  login?: unknown;
  type?: unknown;
}

/**
 * True only for a human account (`type` exactly `User`) on the list. A missing
 * account (deleted users appear as null), a missing type, bots and
 * organizations are all refused.
 */
export function isAllowlisted(
  allowlist: Allowlist,
  account: GitHubAccount | null | undefined,
): boolean {
  const login = account?.login;
  if (account?.type !== "User" || typeof login !== "string" || !LOGIN.test(login)) return false;
  return allowlist.logins.has(login.toLowerCase());
}

/** Repository roles with at least triage access; only they may steer the agents. Custom roles don't count. */
export const STEERING_ROLES: ReadonlySet<string> = new Set([
  "triage",
  "write",
  "maintain",
  "admin",
]);
