/**
 * The metrics job's settings, read from its environment. Errors name the
 * setting that is wrong, never its value.
 */
export interface MetricsSettings {
  repo: string;
  token: string;
  portalBotLogin: string;
  agentAppLogin: string;
  days: number;
}

type Env = Record<string, string | undefined>;

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** A GitHub login, with the `[bot]` suffix apps carry. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/;
const DEFAULT_DAYS = 90;

function required(env: Env, name: string, pattern?: RegExp): string {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is not set`);
  if (pattern && !pattern.test(value)) throw new Error(`${name} is not valid`);
  return value;
}

export function readMetricsSettings(env: Env): MetricsSettings {
  const days = env.METRICS_DAYS?.trim() ?? "";
  if (days && !/^\d{1,3}$/.test(days)) throw new Error("METRICS_DAYS is not valid");
  const window = days ? Number(days) : DEFAULT_DAYS;
  if (window < 1 || window > 365) throw new Error("METRICS_DAYS must be between 1 and 365");
  return {
    repo: required(env, "GITHUB_REPOSITORY", REPO),
    token: required(env, "GITHUB_TOKEN"),
    portalBotLogin: required(env, "PORTAL_BOT_LOGIN", LOGIN),
    agentAppLogin: required(env, "AGENT_APP_LOGIN", LOGIN),
    days: window,
  };
}
