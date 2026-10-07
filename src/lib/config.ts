/**
 * Server-side configuration, read from environment variables at call time and
 * validated. Missing or malformed values fail closed with a generic 503 for the
 * client; the variable name (never its value) is logged for operators.
 */
import { createPrivateKey } from "node:crypto";

import { HttpError } from "@/lib/api/envelope";
import { log } from "@/lib/log";

type Env = Record<string, string | undefined>;

export const DEFAULT_DAILY_SUBMISSION_CAP = 20;

function notConfigured(name: string): HttpError {
  log.error("config.invalid", { variable: name });
  return new HttpError(503, "NOT_CONFIGURED", "Submissions are temporarily unavailable.");
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw notConfigured(name);
  return value;
}

function positiveInt(env: Env, name: string): number {
  const raw = required(env, name);
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw notConfigured(name);
  return Number(raw);
}

export interface GitHubAppConfig {
  appId: number;
  installationId: number;
  /** PEM text. Accepts real newlines or literal "\n" escapes (common in .env files). */
  privateKey: string;
  owner: string;
  repo: string;
}

export function readGitHubAppConfig(env: Env = process.env): GitHubAppConfig {
  const target = required(env, "REQUEST_TARGET_REPO");
  const match = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(target);
  if (!match || match[2] === "." || match[2] === "..") throw notConfigured("REQUEST_TARGET_REPO");

  const privateKey = required(env, "GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  try {
    // Parses and rejects malformed or passphrase-protected keys up front, so
    // signing can't fail later with an unexpected 500.
    createPrivateKey(privateKey);
  } catch {
    throw notConfigured("GH_APP_PRIVATE_KEY");
  }

  return {
    appId: positiveInt(env, "GH_APP_ID"),
    installationId: positiveInt(env, "GH_APP_INSTALLATION_ID"),
    privateKey,
    owner: match[1],
    repo: match[2],
  };
}

export function readDailySubmissionCap(env: Env = process.env): number {
  const raw = env.DAILY_SUBMISSION_CAP?.trim();
  if (!raw) return DEFAULT_DAILY_SUBMISSION_CAP;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw notConfigured("DAILY_SUBMISSION_CAP");
  return Number(raw);
}

/**
 * True for the live deployment: Vercel's production environment, or a
 * production Node process outside Vercel (self-hosting).
 */
export function isProductionDeployment(env: Env = process.env): boolean {
  return env.VERCEL_ENV ? env.VERCEL_ENV === "production" : env.NODE_ENV === "production";
}

/** Cloudflare's documented always-pass/always-fail test secrets. */
export function isTestBotCheckSecret(secret: string): boolean {
  return /^[123]x0{31}AA$/.test(secret);
}

export function readBotCheckSecret(env: Env = process.env): string {
  const secret = required(env, "BOT_CHECK_SECRET_KEY");
  // A test secret in production would let every request through.
  if (isProductionDeployment(env) && isTestBotCheckSecret(secret))
    throw notConfigured("BOT_CHECK_SECRET_KEY");
  return secret;
}

/**
 * Lower-case, punycode, no trailing dot; null when not a plain hostname
 * (ports, IPv6 literals, paths and other junk are rejected).
 */
export function normaliseHostname(name: string): string | null {
  const trimmed = name.trim().replace(/\.$/, "");
  if (!trimmed || /[:/\[\]@\s]/.test(trimmed)) return null;
  try {
    const hostname = new URL(`http://${trimmed}`).hostname;
    return /^[a-z0-9.-]{1,253}$/.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Hostnames the bot-check widget may be served from.
 * - BOT_CHECK_HOSTNAMES (comma-separated) when set; any invalid entry is a config error.
 * - Required in production, so the check can't degrade to "whatever Host the client sent".
 * - Otherwise Vercel's deployment URL (previews), else the request host (local development).
 *   An unusable request host yields an empty list, which rejects every token.
 */
export function readBotCheckHostnames(
  env: Env = process.env,
  requestHost: string | null = null,
): string[] {
  const configured = env.BOT_CHECK_HOSTNAMES?.trim();
  if (configured) {
    const names = configured.split(",").map(normaliseHostname);
    if (names.some((name) => name === null)) throw notConfigured("BOT_CHECK_HOSTNAMES");
    return names as string[];
  }
  if (isProductionDeployment(env)) throw notConfigured("BOT_CHECK_HOSTNAMES");
  const fallback = env.VERCEL_URL ?? requestHost?.replace(/:\d+$/, "") ?? "";
  const name = normaliseHostname(fallback);
  return name ? [name] : [];
}

export function readBlobToken(env: Env = process.env): string {
  return required(env, "BLOB_READ_WRITE_TOKEN");
}
