import { describe, expect, it } from "vitest";

import { buildRequestIssue } from "@/lib/github/issues";

import {
  type StoredScreenshot,
  issueScanSince,
  linkedPathnames,
  normaliseNewlines,
  planCleanup,
  readPositiveInt,
  referencedPathnames,
  removeScreenshotLink,
  trailerOf,
} from "./core.mts";

const NOW = Date.UTC(2026, 9, 7, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const path = (n: number) => `screenshots/${ID(n)}.png`;
const url = (n: number) => `https://abc.public.blob.vercel-storage.com/${path(n)}`;
const shot = (n: number, ageMs: number): StoredScreenshot => ({
  url: url(n),
  pathname: path(n),
  uploadedAt: new Date(NOW - ageMs),
});
const body = (description: string, n: number | null) =>
  buildRequestIssue({ description, screenshotUrl: n === null ? null : url(n) }).body;
const crlf = (text: string) => text.replace(/\n/g, "\r\n");

describe("links in real issue bodies", () => {
  it("finds the trailer link in the body the portal writes", () => {
    expect(linkedPathnames(body("Add dark mode", 1))).toEqual([path(1)]);
  });

  it("still finds it after the web editor saved CRLF line endings", () => {
    expect(linkedPathnames(crlf(body("Add dark mode", 1)))).toEqual([path(1)]);
  });

  it("isn't fooled by fence lines or links inside the description", () => {
    const description = "Steps:\n````\n````text\n**Screenshot:** <" + url(9) + ">\n````";
    expect(linkedPathnames(body(description, 1))).toEqual([path(1)]);
    expect(linkedPathnames(body(description, null))).toEqual([]);
    expect(trailerOf("no fence at all")).toBe("");
  });

  it("finds referenced paths anywhere, including edited or planted mentions", () => {
    const edited = body("Add dark mode", null) + `\n\nUpdated: see ${url(3)}`;
    expect(referencedPathnames(edited)).toEqual([path(3)]);
    expect(referencedPathnames(crlf(body(`mentions ${path(4)}`, 5)))).toEqual([path(4), path(5)]);
  });
});

describe("removeScreenshotLink", () => {
  it("replaces only the trailer link and keeps the description", () => {
    const description = `see **Screenshot:** <${url(1)}> inside`;
    const updated = removeScreenshotLink(body(description, 1), path(1));
    expect(updated).toContain(description);
    expect(updated?.endsWith("**Screenshot:** removed")).toBe(true);
    expect(removeScreenshotLink(updated!, path(1))).toBeNull();
  });

  it("handles CRLF bodies and returns LF", () => {
    const updated = removeScreenshotLink(crlf(body("Add dark mode", 1)), path(1));
    expect(updated).toBe(
      normaliseNewlines(body("Add dark mode", null)) + "\n\n**Screenshot:** removed",
    );
  });
});

describe("planCleanup", () => {
  const plan = (blobs: StoredScreenshot[], referenced: string[] | null) =>
    planCleanup({
      blobs,
      referenced: referenced ? new Set(referenced) : null,
      nowMs: NOW,
      retentionDays: 90,
      orphanGraceHours: 24,
    });

  it("expires at exactly 90 days, referenced or not", () => {
    const result = plan([shot(1, 90 * DAY), shot(2, 90 * DAY - 1)], [path(1), path(2)]);
    expect(result.expired.map((s) => s.pathname)).toEqual([path(1)]);
  });

  it("treats unreferenced uploads as orphans from exactly 24 hours", () => {
    const result = plan([shot(3, 24 * HOUR), shot(4, 24 * HOUR - 1), shot(5, 3 * DAY)], [path(5)]);
    expect(result.orphans.map((s) => s.pathname)).toEqual([path(3)]);
  });

  it("finds no orphans when references are unknown, and skips odd files", () => {
    expect(plan([shot(6, 3 * DAY)], null).orphans).toEqual([]);
    const odd = [
      { url: "https://x/other.png", pathname: "other/file.png", uploadedAt: new Date(0) },
      { ...shot(7, 100 * DAY), uploadedAt: new Date(Number.NaN) },
    ];
    expect(plan(odd, [])).toEqual({ expired: [], orphans: [] });
  });
});

describe("readPositiveInt", () => {
  it("uses the fallback when unset and rejects junk", () => {
    expect(readPositiveInt(undefined, 90, 3650)).toBe(90);
    expect(readPositiveInt("30", 90, 3650)).toBe(30);
    for (const bad of ["0", "-1", "1.5", "abc", "5000"])
      expect(() => readPositiveInt(bad, 90, 3650)).toThrow();
  });
});

describe("issueScanSince", () => {
  it("starts a week before the retention cutoff when all files are recent", () => {
    expect(issueScanSince([shot(1, 3 * DAY)], NOW, 90).getTime()).toBe(NOW - 97 * DAY);
  });

  it("reaches back to a week before the oldest stored file (job was off for a while)", () => {
    expect(issueScanSince([shot(1, 3 * DAY), shot(2, 150 * DAY)], NOW, 90).getTime()).toBe(
      NOW - 157 * DAY,
    );
  });

  it("ignores files with invalid dates", () => {
    const invalid = { ...shot(3, 0), uploadedAt: new Date(Number.NaN) };
    expect(issueScanSince([invalid], NOW, 90).getTime()).toBe(NOW - 97 * DAY);
  });
});
