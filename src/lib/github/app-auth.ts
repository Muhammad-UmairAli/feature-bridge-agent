/**
 * GitHub App authentication without extra dependencies.
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
 *
 * 1. Sign a short-lived app JWT (RS256) with the App's private key.
 * 2. Exchange it for an installation token scoped to one repository and only
 *    the permissions a caller asks for.
 * Tokens are cached in memory until shortly before they expire; concurrent
 * callers share one in-flight request.
 */
import { type KeyObject, createSign } from "node:crypto";

import type { GitHubAppConfig } from "@/lib/config";
import { log } from "@/lib/log";

import { GitHubError, githubRequest } from "./api";

export type InstallationPermissions = Partial<
  Record<"issues" | "pull_requests" | "deployments" | "metadata", "read" | "write">
>;

const base64url = (input: string) => Buffer.from(input).toString("base64url");

/** App JWT: issued 60 s in the past (clock drift), valid for 9 minutes (GitHub allows at most 10). */
export function createAppJwt(
  appId: number,
  privateKey: KeyObject,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
const tokenCache = new Map<string, Promise<CachedToken>>();
/** Refresh this long before expiry so a token never lapses mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Installation tokens last an hour; never trust a longer expiry than that. */
const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

const cacheKey = (config: GitHubAppConfig, permissions: InstallationPermissions) =>
  `${config.appId}:${config.installationId}:${config.repo}:${JSON.stringify(
    Object.fromEntries(Object.entries(permissions).sort()),
  )}`;

/** Test hook: forget cached tokens. */
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

/** Drop a token GitHub rejected (e.g. revoked), so the next call mints a new one. */
export function evictInstallationToken(
  config: GitHubAppConfig,
  permissions: InstallationPermissions,
): void {
  tokenCache.delete(cacheKey(config, permissions));
}

async function mintToken(
  config: GitHubAppConfig,
  permissions: InstallationPermissions,
  nowMs: number,
  fetchImpl?: typeof fetch,
): Promise<CachedToken> {
  const result = await githubRequest<{ token?: unknown; expires_at?: unknown }>(
    `/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      auth: createAppJwt(config.appId, config.privateKey, nowMs),
      // Narrow the token to the one repository and the permissions requested.
      body: { repositories: [config.repo], permissions },
      operation: "app.installation_token",
      fetchImpl,
    },
  );
  const expiresAtMs = typeof result.expires_at === "string" ? Date.parse(result.expires_at) : NaN;
  if (typeof result.token !== "string" || !result.token || Number.isNaN(expiresAtMs)) {
    log.error("github.malformed_token_response");
    throw new GitHubError(201, false);
  }
  return { token: result.token, expiresAtMs: Math.min(expiresAtMs, nowMs + MAX_TOKEN_LIFETIME_MS) };
}

export async function getInstallationToken(
  config: GitHubAppConfig,
  permissions: InstallationPermissions,
  options: { fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<string> {
  const nowMs = options.nowMs ?? Date.now();
  const key = cacheKey(config, permissions);

  const pending = tokenCache.get(key);
  if (pending) {
    try {
      const cached = await pending;
      if (cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) return cached.token;
    } catch {
      // A failed mint was already removed below; fall through and retry.
    }
    if (tokenCache.get(key) === pending) tokenCache.delete(key);
  }

  const minting = mintToken(config, permissions, nowMs, options.fetchImpl);
  tokenCache.set(key, minting);
  try {
    return (await minting).token;
  } catch (error) {
    if (tokenCache.get(key) === minting) tokenCache.delete(key);
    throw error;
  }
}
