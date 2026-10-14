/**
 * The build jobs' environment, read and checked in one place. The approval
 * ids come from the gate job's outputs and are re-verified before use.
 */
import { readAllowlist } from "../lib/allowlist.mts";
import type { BuildSettings } from "./build.mts";

type Env = Record<string, string | undefined>;

const ID = /^[1-9]\d{0,15}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function readBuildSettings(
  env: Env,
):
  | { ok: true; settings: BuildSettings; token: string; repo: string }
  | { ok: false; problems: string[] } {
  const value = (name: string) => env[name]?.trim() ?? "";
  const problems: string[] = [];
  if (!value("GITHUB_TOKEN")) problems.push("GITHUB_TOKEN missing");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value("GITHUB_REPOSITORY"))) {
    problems.push("GITHUB_REPOSITORY missing or invalid");
  }
  if (!/^[1-9]\d{0,9}$/.test(value("ISSUE_NUMBER")))
    problems.push("ISSUE_NUMBER missing or invalid");
  if (!value("PORTAL_BOT_LOGIN")) problems.push("PORTAL_BOT_LOGIN missing");
  for (const name of ["APPROVAL_EVENT_ID", "PLAN_COMMENT_ID"]) {
    if (!ID.test(value(name))) problems.push(`${name} missing or invalid`);
  }
  if (!SHA256.test(value("PLAN_SHA256"))) problems.push("PLAN_SHA256 missing or invalid");
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    token: value("GITHUB_TOKEN"),
    repo: value("GITHUB_REPOSITORY"),
    settings: {
      issueNumber: Number(value("ISSUE_NUMBER")),
      portalBotLogin: value("PORTAL_BOT_LOGIN"),
      allowlist: readAllowlist(env),
      expected: {
        approvalEventId: Number(value("APPROVAL_EVENT_ID")),
        planCommentId: Number(value("PLAN_COMMENT_ID")),
        planSha256: value("PLAN_SHA256"),
      },
    },
  };
}
