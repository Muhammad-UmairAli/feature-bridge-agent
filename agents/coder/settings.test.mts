// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readBuildSettings } from "./settings.mts";

const env = {
  GITHUB_TOKEN: "fake-token",
  GITHUB_REPOSITORY: "octo/requests",
  ISSUE_NUMBER: "7",
  PORTAL_BOT_LOGIN: "request-portal[bot]",
  APPROVER_ALLOWLIST: "lead",
  APPROVAL_EVENT_ID: "123456789",
  PLAN_COMMENT_ID: "987",
  PLAN_SHA256: "a".repeat(64),
};

describe("readBuildSettings", () => {
  it("reads the build's environment", () => {
    const read = readBuildSettings(env);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.repo).toBe("octo/requests");
    expect(read.settings).toMatchObject({
      issueNumber: 7,
      portalBotLogin: "request-portal[bot]",
      expected: { approvalEventId: 123456789, planCommentId: 987, planSha256: "a".repeat(64) },
    });
    expect([...read.settings.allowlist.logins]).toEqual(["lead"]);
  });

  it("names everything missing or invalid, without values", () => {
    expect(readBuildSettings({})).toEqual({
      ok: false,
      problems: [
        "GITHUB_TOKEN missing",
        "GITHUB_REPOSITORY missing or invalid",
        "ISSUE_NUMBER missing or invalid",
        "PORTAL_BOT_LOGIN missing",
        "APPROVAL_EVENT_ID missing or invalid",
        "PLAN_COMMENT_ID missing or invalid",
        "PLAN_SHA256 missing or invalid",
      ],
    });
    for (const [name, value] of [
      ["APPROVAL_EVENT_ID", "0"],
      ["PLAN_COMMENT_ID", "12x"],
      ["PLAN_SHA256", "A".repeat(64)],
      ["ISSUE_NUMBER", "07"],
      ["GITHUB_REPOSITORY", "octo"],
    ]) {
      expect(readBuildSettings({ ...env, [name]: value }).ok).toBe(false);
    }
  });
});
