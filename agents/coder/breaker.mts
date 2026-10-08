/**
 * The CI circuit breaker: when CI fails on a coding agent pull request for the
 * second run in a row, the pull request goes to a maintainer
 * (`escalated-to-human`), and the agent makes no further commits on it (the
 * revision jobs refuse escalated pull requests). Runs after each failed CI run
 * (`workflow_run`, default branch code, no secrets). Cancelled and skipped runs
 * don't break a streak; a passing run ends it. Runs are counted, not commits
 * (a re-run counts once; CI re-triggered on the same commit counts again), and
 * only runs from this repository (forks can reuse branch names).
 */
import type { GitHubClient, PullClient } from "../lib/github.mts";
import type { Log } from "../planner/planner.mts";
import { LABELS } from "../planner/request.mts";
import { classify } from "../scope-check/check.mts";

export const BREAKER_MARKER = "<!-- feature-bridge-agent:ci-breaker -->";
const MAX_FAILED_RUNS = 2;

export interface BreakerSettings {
  pullNumber: number;
  /** The CI workflow's id and the branch it ran on, from the event. */
  workflowId: number;
  branch: string;
  /** owner/name */
  repo: string;
  agentLogin: string;
}

export type BreakerOutcome = "skipped" | "ok" | "tripped";

/** Failed runs in a row, newest first, among finished runs that passed or failed. */
export function failedInARow(conclusions: string[]): number {
  let failed = 0;
  for (const conclusion of conclusions) {
    if (conclusion === "success") break;
    if (conclusion === "failure" || conclusion === "timed_out") failed += 1;
  }
  return failed;
}

export async function checkBreaker(
  settings: BreakerSettings,
  deps: { github: GitHubClient & PullClient; log: Log },
): Promise<BreakerOutcome> {
  const { github, log } = deps;
  const number = settings.pullNumber;
  const pull = await github.getPull(number);
  const kind = classify({
    headRef: pull.headRef,
    headRepo: pull.headRepo,
    baseRepo: settings.repo,
    baseRef: pull.baseRef,
    author: pull.user?.login ?? "",
    agentLogin: settings.agentLogin,
  });
  if (kind.kind !== "request" || pull.state !== "open" || pull.headRef !== settings.branch) {
    log("info", "breaker.skipped", { pull: number, reason: "not_agent_pull" });
    return "skipped";
  }
  // Only this repository's runs: a fork can use the same branch name and its own CI result.
  const runs = await github.latestWorkflowRuns(settings.workflowId, settings.branch);
  const failed = failedInARow(
    runs
      .filter((run) => run.status === "completed" && run.headRepo === settings.repo)
      .map((run) => run.conclusion),
  );
  if (failed < MAX_FAILED_RUNS) {
    log("info", "breaker.ok", { pull: number, failed });
    return "ok";
  }
  if ((await github.getIssue(number)).labels.includes(LABELS.escalatedToHuman)) {
    log("info", "breaker.skipped", { pull: number, reason: "already_escalated" });
    return "skipped";
  }
  await github.addLabels(number, [LABELS.escalatedToHuman]);
  await github.createComment(
    number,
    `${BREAKER_MARKER}\n### Handed to a maintainer\n\nCI failed on ${failed} runs in a row, so the coding agent won't change this pull request any further. A maintainer will take it from here.`,
  );
  log("info", "breaker.tripped", { pull: number, failed });
  return "tripped";
}
