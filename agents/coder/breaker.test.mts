// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { Pull, WorkflowRun } from "../lib/github.mts";
import { BREAKER_MARKER, checkBreaker, failedInARow } from "./breaker.mts";
import type { ReviseClient } from "./revise.mts";

describe("failedInARow", () => {
  it("counts failures back to the last passing run, skipping cancelled ones", () => {
    expect(failedInARow([])).toBe(0);
    expect(failedInARow(["failure"])).toBe(1);
    expect(failedInARow(["failure", "cancelled", "timed_out", "success", "failure"])).toBe(2);
    expect(failedInARow(["success", "failure", "failure"])).toBe(0);
  });
});

const pull: Pull = {
  number: 30,
  state: "open",
  user: { login: "coder[bot]", id: 5, type: "Bot" },
  headRef: "request-7",
  headSha: "c".repeat(40),
  headRepo: "octo/requests",
  baseRef: "main",
};
const settings = {
  pullNumber: 30,
  workflowId: 123,
  branch: "request-7",
  repo: "octo/requests",
  agentLogin: "coder[bot]",
};
const run = (
  conclusion: string,
  status = "completed",
  headRepo = "octo/requests",
): WorkflowRun => ({
  id: 1,
  status,
  conclusion,
  headRepo,
});

function fake(runs: WorkflowRun[], labels: string[] = [], current: Pull = pull) {
  const github = {
    getPull: vi.fn(async () => current),
    getIssue: vi.fn(async () => ({
      number: 30,
      state: "open",
      body: "",
      user: current.user,
      labels,
      isPullRequest: true,
    })),
    latestWorkflowRuns: vi.fn(async () => runs),
    addLabels: vi.fn(async () => {}),
    createComment: vi.fn(async () => {}),
  };
  return { github, client: github as unknown as ReviseClient };
}

describe("checkBreaker", () => {
  it("hands the pull request over after two failed runs in a row", async () => {
    const { github, client } = fake([run("", "in_progress"), run("failure"), run("failure")]);
    expect(await checkBreaker(settings, { github: client, log: vi.fn() })).toBe("tripped");
    expect(github.latestWorkflowRuns).toHaveBeenCalledWith(123, "request-7");
    expect(github.addLabels).toHaveBeenCalledWith(30, ["escalated-to-human"]);
    expect(github.createComment).toHaveBeenCalledWith(
      30,
      expect.stringMatching(new RegExp(`^${BREAKER_MARKER}\\n### Handed to a maintainer`)),
    );
  });

  it("ignores runs from forks that reuse the branch name", async () => {
    const reset = fake([
      run("failure"),
      run("success", "completed", "fork/requests"),
      run("failure"),
    ]);
    expect(await checkBreaker(settings, { github: reset.client, log: vi.fn() })).toBe("tripped");
    const padded = fake([run("failure"), run("failure", "completed", "fork/requests")]);
    expect(await checkBreaker(settings, { github: padded.client, log: vi.fn() })).toBe("ok");
  });

  it("does nothing after one failure, or when already handed over", async () => {
    const once = fake([run("failure"), run("success"), run("failure")]);
    expect(await checkBreaker(settings, { github: once.client, log: vi.fn() })).toBe("ok");
    const handed = fake([run("failure"), run("failure")], ["escalated-to-human"]);
    expect(await checkBreaker(settings, { github: handed.client, log: vi.fn() })).toBe("skipped");
    for (const { github } of [once, handed]) {
      expect(github.addLabels).not.toHaveBeenCalled();
      expect(github.createComment).not.toHaveBeenCalled();
    }
  });

  it("only acts on the coding agent's open request pull request for that branch", async () => {
    for (const current of [
      { ...pull, user: { login: "someone", id: 9, type: "User" } },
      { ...pull, state: "closed" },
      { ...pull, headRef: "request-8" },
      { ...pull, headRepo: "fork/requests" },
    ]) {
      const { github, client } = fake([run("failure"), run("failure")], [], current);
      expect(await checkBreaker(settings, { github: client, log: vi.fn() })).toBe("skipped");
      expect(github.latestWorkflowRuns).not.toHaveBeenCalled();
    }
  });
});
