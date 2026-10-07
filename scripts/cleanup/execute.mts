/**
 * Carries out a cleanup plan. An expired file is deleted only after every
 * issue linking it was updated, so issues never keep a link to a missing file;
 * if an update fails, the file stays for the next run and the run fails.
 * Each issue is re-read just before it's edited, so concurrent edits survive.
 */
import { type CleanupPlan, removeScreenshotLink } from "./core.mts";

export interface CleanupDeps {
  getIssueBody(number: number): Promise<string>;
  updateIssueBody(number: number, body: string): Promise<void>;
  deleteBlobs(urls: string[]): Promise<void>;
}

export interface CleanupResult {
  deleted: number;
  linksRemoved: number;
  kept: number;
  failures: number;
}

const BATCH = 100;

export async function executeCleanup(
  plan: CleanupPlan,
  /** pathname → issues whose trailer links it; null when issues couldn't be read */
  linkingIssues: Map<string, number[]> | null,
  deps: CleanupDeps,
  dryRun: boolean,
): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, linksRemoved: 0, kept: 0, failures: 0 };
  if (dryRun) return result;

  const toDelete: string[] = plan.orphans.map((blob) => blob.url);
  if (linkingIssues === null) {
    // Links are unknown: deleting expired files could leave dead links behind.
    result.kept += plan.expired.length;
    if (plan.expired.length > 0) result.failures += 1;
  } else {
    for (const blob of plan.expired) {
      let ok = true;
      for (const number of linkingIssues.get(blob.pathname) ?? []) {
        try {
          const updated = removeScreenshotLink(await deps.getIssueBody(number), blob.pathname);
          if (updated !== null) {
            await deps.updateIssueBody(number, updated);
            result.linksRemoved += 1;
          }
        } catch {
          ok = false;
        }
      }
      if (ok) {
        toDelete.push(blob.url);
      } else {
        result.kept += 1;
        result.failures += 1;
      }
    }
  }

  for (let start = 0; start < toDelete.length; start += BATCH) {
    const batch = toDelete.slice(start, start + BATCH);
    try {
      await deps.deleteBlobs(batch);
      result.deleted += batch.length;
    } catch {
      result.failures += 1;
    }
  }
  return result;
}
