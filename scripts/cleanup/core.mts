/**
 * Pure decisions for the screenshot cleanup job.
 *
 * Two different trust levels:
 * - Keeping a file: a screenshot counts as referenced if its path appears
 *   anywhere in any recent issue. This fails safe: edits, CRLF line endings,
 *   a dropped label or a planted mention can only keep a file longer, and
 *   the 90-day expiry still applies.
 * - Editing a link: only the "**Screenshot:** <url>" line after the request's
 *   closing fence in a portal-created issue is replaced. Text inside the fence
 *   is the visitor's own and is never edited.
 */

export interface StoredScreenshot {
  url: string;
  pathname: string;
  uploadedAt: Date;
}

export const SCREENSHOT_PATHNAME =
  /^screenshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
const PATHNAME_ANYWHERE =
  /screenshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)/g;
const LINK_LINE = /^\*\*Screenshot:\*\* <(https:\/\/[^\s<>]+)>$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** GitHub stores bodies edited in the web UI with CRLF; parse everything as LF. */
export const normaliseNewlines = (body: string) => body.replace(/\r\n?/g, "\n");

/** Every stored-screenshot path mentioned anywhere in the text. */
export function referencedPathnames(body: string): string[] {
  return Array.from(normaliseNewlines(body).matchAll(PATHNAME_ANYWHERE), (match) => match[0]);
}

/** The part of a (normalised) issue body after the request's closing fence ("" if none). */
export function trailerOf(body: string): string {
  const lines = normaliseNewlines(body).split("\n");
  const open = lines.findIndex((line) => /^`{3,}text$/.test(line));
  if (open === -1) return "";
  const fence = lines[open].slice(0, -"text".length);
  const close = lines.findIndex((line, index) => index > open && line === fence);
  return close === -1 ? "" : lines.slice(close + 1).join("\n");
}

const pathnameOf = (url: string) => {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
};

/** Screenshot paths linked from the trailer of a portal-created issue body. */
export function linkedPathnames(body: string): string[] {
  return trailerOf(body)
    .split("\n")
    .map((line) => LINK_LINE.exec(line)?.[1])
    .filter((url): url is string => Boolean(url))
    .map(pathnameOf)
    .filter((pathname) => SCREENSHOT_PATHNAME.test(pathname));
}

/**
 * Replace the trailer link to `pathname` with "removed". Returns the new
 * (LF-normalised) body, or null when there's nothing to change.
 */
export function removeScreenshotLink(body: string, pathname: string): string | null {
  const normalised = normaliseNewlines(body);
  const trailer = trailerOf(normalised);
  if (!trailer) return null;
  let changed = false;
  const lines = trailer.split("\n").map((line) => {
    const url = LINK_LINE.exec(line)?.[1];
    if (url && pathnameOf(url) === pathname) {
      changed = true;
      return "**Screenshot:** removed";
    }
    return line;
  });
  if (!changed) return null;
  return normalised.slice(0, normalised.length - trailer.length) + lines.join("\n");
}

export interface CleanupPlan {
  expired: StoredScreenshot[];
  orphans: StoredScreenshot[];
}

/**
 * Expired: at or past the retention period. Orphans: past the grace period
 * and referenced nowhere (only when references are known). Files that don't
 * look like stored screenshots, or have no valid date, are never touched.
 */
export function planCleanup(input: {
  blobs: StoredScreenshot[];
  referenced: Set<string> | null;
  nowMs: number;
  retentionDays: number;
  orphanGraceHours: number;
}): CleanupPlan {
  const { blobs, referenced, nowMs, retentionDays, orphanGraceHours } = input;
  const expireBefore = nowMs - retentionDays * DAY_MS;
  const orphanBefore = nowMs - orphanGraceHours * 60 * 60 * 1000;
  const expired: StoredScreenshot[] = [];
  const orphans: StoredScreenshot[] = [];
  for (const blob of blobs) {
    const uploaded = blob.uploadedAt.getTime();
    if (!SCREENSHOT_PATHNAME.test(blob.pathname) || Number.isNaN(uploaded)) continue;
    if (uploaded <= expireBefore) {
      expired.push(blob);
    } else if (referenced && uploaded <= orphanBefore && !referenced.has(blob.pathname)) {
      orphans.push(blob);
    }
  }
  return { expired, orphans };
}

/** Positive integer from an env value, or the fallback. Rejects anything else. */
export function readPositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max)
    throw new Error(`invalid number: ${value}`);
  return Number(value);
}

/**
 * Start of the issue scan. A request's issue is created right after its
 * screenshot is uploaded, so scanning from 7 days before the oldest stored
 * file (or before the retention cutoff, if earlier) covers every issue that
 * could link a file that still exists, even after the job was off for a while.
 */
export function issueScanSince(
  blobs: StoredScreenshot[],
  nowMs: number,
  retentionDays: number,
): Date {
  const margin = 7 * DAY_MS;
  const retentionCutoff = nowMs - retentionDays * DAY_MS;
  const oldest = blobs.reduce((min, blob) => {
    const uploaded = blob.uploadedAt.getTime();
    return Number.isNaN(uploaded) ? min : Math.min(min, uploaded);
  }, retentionCutoff);
  return new Date(oldest - margin);
}
