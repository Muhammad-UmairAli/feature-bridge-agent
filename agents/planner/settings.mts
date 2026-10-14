/**
 * The planner's environment: what the workflow passes in, read and checked
 * in one place so the entry script stays thin.
 */
import { readAllowlist } from "../lib/allowlist.mts";
import type { PlannerSettings, ScreenshotState } from "./planner.mts";

type Env = Record<string, string | undefined>;

export interface RunSettings extends PlannerSettings {
  token: string;
  repo: string;
}

/** The settings, or the names of what's missing or invalid (never their values). */
export function readPlannerSettings(
  env: Env,
): { ok: true; settings: RunSettings; warnings: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const token = env.GITHUB_TOKEN ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  const issue = env.ISSUE_NUMBER?.trim() ?? "";
  const portalBotLogin = env.PORTAL_BOT_LOGIN?.trim() ?? "";
  const rawMode = env.PLANNER_MODE?.trim() || "plan";
  if (!token) problems.push("GITHUB_TOKEN missing");
  if (!repo) problems.push("GITHUB_REPOSITORY missing");
  if (!/^[1-9]\d{0,9}$/.test(issue)) problems.push("ISSUE_NUMBER missing or invalid");
  if (!portalBotLogin) problems.push("PORTAL_BOT_LOGIN missing");
  const mode = rawMode === "plan" || rawMode === "revise" ? rawMode : null;
  if (mode === null) problems.push("PLANNER_MODE must be plan or revise");
  if (problems.length > 0 || mode === null) return { ok: false, problems };

  const warnings = portalBotLogin.endsWith("[bot]")
    ? []
    : ["PORTAL_BOT_LOGIN doesn't end in [bot], so no issue will match it"];
  const allowlist = readAllowlist(env);
  if (mode === "revise") {
    if (allowlist.rejected > 0) {
      warnings.push(`APPROVER_ALLOWLIST has ${allowlist.rejected} invalid entries`);
    }
    if (allowlist.logins.size === 0)
      warnings.push("APPROVER_ALLOWLIST is empty, so nobody can revise");
  }
  return {
    ok: true,
    warnings,
    settings: {
      token,
      repo,
      issueNumber: Number(issue),
      portalBotLogin,
      imageInput: env.LLM_IMAGE_INPUT === "on",
      mode,
      ...(mode === "revise" ? { allowlist } : {}),
    },
  };
}

/** Whether a stored screenshot still exists (it may have been taken down or expired). */
export async function checkScreenshot(
  url: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<ScreenshotState> {
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "available";
    return response.status === 404 || response.status === 410 ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}
