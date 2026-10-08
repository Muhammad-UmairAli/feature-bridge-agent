/**
 * Reading a request issue the portal created: who may have created it, and
 * the untrusted description and screenshot link in its body. The portal
 * writes the description verbatim inside a backtick fence tagged `text`, with
 * a fence longer than any backtick run in the description, and adds the
 * screenshot link after the closing fence. Only that trailer is trusted for
 * the link: text inside the fence is the visitor's own.
 */
import { createHash } from "node:crypto";

import type { Issue } from "../lib/github.mts";

export const LABELS = {
  portalRequest: "portal-request",
  planning: "planning",
  planReady: "plan-ready",
  changesRequested: "changes-requested",
  approved: "approved-by-human",
  needsHumanTriage: "needs-human-triage",
} as const;

/** The portal's limit; anything longer was edited after submission. */
export const DESCRIPTION_MAX_CODE_POINTS = 5_000;

/**
 * Only open issues the portal's bot account created, with the request label.
 * Issues opened directly on GitHub skip the portal's bot check and daily cap,
 * so agents ignore them.
 */
export function isPortalIssue(issue: Issue, portalBotLogin: string): boolean {
  return (
    !issue.isPullRequest &&
    issue.state === "open" &&
    issue.user?.type === "Bot" &&
    issue.user.login.toLowerCase() === portalBotLogin.toLowerCase() &&
    issue.labels.includes(LABELS.portalRequest)
  );
}

/**
 * Characters people can't see but models can read: controls (except line
 * breaks and tabs), format characters such as zero-width and bidi overrides,
 * Unicode tags, private-use and unassigned code points, and line separators.
 */
export const INVISIBLE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/;
const SCREENSHOT_PATH =
  /^\/screenshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
const LINK_LINE = /^\*\*Screenshot:\*\* <([^<>\s]+)>$/;

function screenshotUrl(line: string): string | null {
  const match = LINK_LINE.exec(line);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    const ok =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      BLOB_HOST.test(url.hostname) &&
      SCREENSHOT_PATH.test(url.pathname);
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

export interface RequestBody {
  /** NFC-normalised, invisible characters removed; may be over the portal's limit. */
  description: string;
  /** The stored screenshot linked after the fence, if any. */
  screenshotUrl: string | null;
}

/** The request in a portal-written body, or null if the body isn't in that format. */
export function parseRequestBody(body: string): RequestBody | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const open = lines.findIndex((line) => /^`{3,}text$/.test(line));
  if (open === -1) return null;
  const fence = lines[open].slice(0, -"text".length);
  const close = lines.indexOf(fence, open + 1);
  if (close === -1) return null;
  const description = lines
    .slice(open + 1, close)
    .join("\n")
    .normalize("NFC")
    .replace(INVISIBLE, "");
  if (!description.trim()) return null;
  const trailer = lines.slice(close + 1);
  return {
    description,
    screenshotUrl: trailer.map(screenshotUrl).find((url) => url !== null) ?? null,
  };
}

/** A fingerprint of the request a plan was made from: its text and screenshot link. */
export const requestHash = (request: RequestBody) =>
  createHash("sha256")
    .update(JSON.stringify([request.description, request.screenshotUrl]))
    .digest("hex");

export const codePoints = (text: string) => Array.from(text).length;

/** The demo folder the workflow assigns: derived from the issue number, never from request text. */
export const demoSlug = (issueNumber: number) => `request-${issueNumber}`;
