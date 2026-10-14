import { describe, expect, it, vi } from "vitest";

import { buildRequestIssue } from "@/lib/github/issues";

import type { CleanupPlan, StoredScreenshot } from "./core.mts";
import { type CleanupDeps, executeCleanup } from "./execute.mts";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const shot = (n: number): StoredScreenshot => ({
  url: `https://abc.public.blob.vercel-storage.com/screenshots/${ID(n)}.png`,
  pathname: `screenshots/${ID(n)}.png`,
  uploadedAt: new Date(0),
});
const bodyFor = (n: number) =>
  buildRequestIssue({ description: "Add dark mode", screenshotUrl: shot(n).url }).body;

function deps(overrides: Partial<CleanupDeps> = {}) {
  const calls: string[] = [];
  const value: CleanupDeps = {
    getIssueBody: vi.fn(async (number: number) => {
      calls.push(`get ${number}`);
      return bodyFor(1);
    }),
    updateIssueBody: vi.fn(async (number: number) => void calls.push(`update ${number}`)),
    deleteBlobs: vi.fn(async (urls: string[]) => void calls.push(`delete ${urls.length}`)),
    ...overrides,
  };
  return { value, calls };
}

const plan = (expired: StoredScreenshot[], orphans: StoredScreenshot[] = []): CleanupPlan => ({
  expired,
  orphans,
});

describe("executeCleanup", () => {
  it("changes nothing in a dry run", async () => {
    const { value, calls } = deps();
    expect(await executeCleanup(plan([shot(1)], [shot(2)]), new Map(), value, true)).toEqual({
      deleted: 0,
      linksRemoved: 0,
      kept: 0,
      failures: 0,
    });
    expect(calls).toEqual([]);
  });

  it("re-reads and updates linking issues before deleting an expired file", async () => {
    const { value, calls } = deps();
    const result = await executeCleanup(
      plan([shot(1)], [shot(2)]),
      new Map([[shot(1).pathname, [7]]]),
      value,
      false,
    );
    expect(calls).toEqual(["get 7", "update 7", "delete 2"]);
    expect(result).toEqual({ deleted: 2, linksRemoved: 1, kept: 0, failures: 0 });
    expect(vi.mocked(value.updateIssueBody).mock.calls[0][1]).toMatch(
      /\*\*Screenshot:\*\* removed$/,
    );
  });

  it("keeps an expired file whose link couldn't be replaced", async () => {
    const { value } = deps({
      updateIssueBody: vi.fn(async () => {
        throw new Error("GitHub PATCH failed with 502");
      }),
    });
    const result = await executeCleanup(
      plan([shot(1)], [shot(2)]),
      new Map([[shot(1).pathname, [7]]]),
      value,
      false,
    );
    expect(vi.mocked(value.deleteBlobs).mock.calls[0][0]).toEqual([shot(2).url]);
    expect(result).toMatchObject({ deleted: 1, kept: 1, failures: 1 });
  });

  it("keeps expired files when issues couldn't be read", async () => {
    const { value } = deps();
    const result = await executeCleanup(plan([shot(1)]), null, value, false);
    expect(value.deleteBlobs).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kept: 1, failures: 1 });
  });

  it("deletes in batches of 100 and counts a failed batch", async () => {
    let batches = 0;
    const { value } = deps({
      deleteBlobs: vi.fn(async () => {
        if (++batches === 2) throw new Error("blob down");
      }),
    });
    const orphans = Array.from({ length: 250 }, (_, i) => shot(i + 10));
    const result = await executeCleanup(plan([], orphans), new Map(), value, false);
    expect(vi.mocked(value.deleteBlobs).mock.calls.map(([urls]) => urls.length)).toEqual([
      100, 100, 50,
    ]);
    expect(result).toMatchObject({ deleted: 150, failures: 1 });
  });
});
