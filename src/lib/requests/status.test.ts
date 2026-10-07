import { describe, expect, it } from "vitest";

import { LABELS } from "./labels";
import { type StatusInput, STATUS_STEPS, STATUS_TEXT, deriveStatus, stepIndex } from "./status";

const base: StatusInput = {
  issueState: "open",
  labels: [LABELS.portalRequest],
  pullRequest: null,
  previewUrl: null,
};
const openPr = { state: "open" as const, merged: false };

describe("deriveStatus", () => {
  it.each<[string, Partial<StatusInput>, string]>([
    ["new request", {}, "submitted"],
    ["planning", { labels: [LABELS.planning] }, "planning"],
    ["plan posted", { labels: [LABELS.planning, LABELS.planReady] }, "awaiting-approval"],
    ["plan rejected", { labels: [LABELS.planReady, LABELS.changesRequested] }, "changes-requested"],
    ["approved", { labels: [LABELS.planReady, LABELS.approved] }, "building"],
    ["PR open", { labels: [LABELS.approved], pullRequest: openPr }, "in-review"],
    [
      "PR with preview",
      { pullRequest: openPr, previewUrl: "https://preview.example" },
      "preview-ready",
    ],
    ["merged", { issueState: "closed", pullRequest: { state: "closed", merged: true } }, "merged"],
    ["planning stopped", { labels: [LABELS.needsHumanTriage] }, "needs-human"],
    [
      "coding stopped",
      { labels: [LABELS.approved, LABELS.escalatedToHuman], pullRequest: openPr },
      "needs-human",
    ],
    [
      "closed without merge",
      { issueState: "closed", pullRequest: { state: "closed", merged: false } },
      "closed",
    ],
  ])("%s → %s", (_name, overrides, expected) => {
    expect(
      deriveStatus({
        ...base,
        ...overrides,
        labels: [...base.labels, ...(overrides.labels ?? [])],
      }),
    ).toBe(expected);
  });

  it("prefers a merged PR over a stop label", () => {
    expect(
      deriveStatus({
        ...base,
        labels: [LABELS.escalatedToHuman],
        pullRequest: { state: "closed", merged: true },
      }),
    ).toBe("merged");
  });

  it("has text for every status and steps that are all known statuses", () => {
    for (const step of STATUS_STEPS) expect(STATUS_TEXT[step].label).toBeTruthy();
  });

  it("treats a closed issue as closed even with a stop label", () => {
    expect(deriveStatus({ ...base, issueState: "closed", labels: [LABELS.escalatedToHuman] })).toBe(
      "closed",
    );
  });

  it("lets approval win over an earlier change request", () => {
    expect(deriveStatus({ ...base, labels: [LABELS.changesRequested, LABELS.approved] })).toBe(
      "building",
    );
  });
});

describe("stepIndex", () => {
  it("places changes requested on the planning step and side states off the path", () => {
    expect(stepIndex("changes-requested")).toBe(STATUS_STEPS.indexOf("planning"));
    expect(stepIndex("needs-human")).toBe(-1);
    expect(stepIndex("closed")).toBe(-1);
    expect(stepIndex("merged")).toBe(STATUS_STEPS.length - 1);
  });
});
