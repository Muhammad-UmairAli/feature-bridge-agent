/**
 * The coding agent's GitHub App authentication, with node:crypto only.
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
 *
 * 1. Sign a short-lived app JWT (RS256) with the App's private key.
 * 2. Look up the App's installation on this repository.
 * 3. Refuse to go on unless the installation itself is limited to selected
 *    repositories and holds exactly the agent's permissions (contents and pull
 *    requests write, metadata read): a token can't be checked for permissions
 *    the App holds but wasn't asked for, so the installation is checked instead.
 * 4. Exchange the JWT for a token for this one repository and those
 *    permissions, verify it, and mask it (and the JWT) in workflow logs.
 */
import { type KeyObject, createPrivateKey, createSign } from "node:crypto";

import { GitHubApiError } from "./github.mts";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

export interface AgentAppConfig {
  appId: number;
  /** Not enumerable, so logging a config doesn't print it. */
  privateKey: KeyObject;
  /** owner/name */
  repo: string;
}

export class AgentAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAppConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** The App's settings (from the publishing job's environment); names only in errors. */
export function readAgentAppConfig(env: Env = process.env): AgentAppConfig {
  const appId = env.AGENT_APP_ID?.trim() ?? "";
  const pem = (env.AGENT_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  const repo = env.GITHUB_REPOSITORY ?? "";
  const missing = [
    !appId && "AGENT_APP_ID",
    !pem && "AGENT_APP_PRIVATE_KEY",
    !repo && "GITHUB_REPOSITORY",
  ].filter(Boolean);
  if (missing.length > 0)
    throw new AgentAppConfigError(`Missing configuration: ${missing.join(", ")}`);
  if (!/^[1-9]\d{0,9}$/.test(appId)) throw new AgentAppConfigError("AGENT_APP_ID must be a number");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new AgentAppConfigError("GITHUB_REPOSITORY must look like owner/name");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new AgentAppConfigError("AGENT_APP_PRIVATE_KEY isn't a valid private key");
  }
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (privateKey.asymmetricKeyType !== "rsa" || bits < 2048) {
    throw new AgentAppConfigError("AGENT_APP_PRIVATE_KEY must be an RSA key of at least 2048 bits");
  }
  // Child processes must not inherit the key.
  if (env === process.env) delete process.env.AGENT_APP_PRIVATE_KEY;
  const config = { appId: Number(appId), repo } as AgentAppConfig;
  Object.defineProperty(config, "privateKey", { value: privateKey, enumerable: false });
  return config;
}

const base64url = (input: string) => Buffer.from(input).toString("base64url");

/** App JWT: issued 60 s in the past (clock drift), expiring 2 minutes from now; it's used at once. */
export function createAppJwt(
  appId: number,
  privateKey: KeyObject,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 3 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

export type Permissions = Partial<Record<"contents" | "pull_requests", "write">>;

/** Everything the agent App may hold: anything else (Workflows above all) stops the build. */
export const AGENT_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

type Fetch = typeof fetch;

/** Mask a runtime credential in workflow logs (registered secrets are masked already). */
function mask(value: string) {
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${value}`);
}

async function call(
  fetchImpl: Fetch,
  operation: string,
  path: string,
  auth: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "feature-bridge-agent",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubApiError(operation, 0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new GitHubApiError(operation, response.status);
  }
  if (response.status === 204) return {};
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    // Parse errors can quote the body, which may hold a token.
    throw new GitHubApiError(operation, 0);
  }
}

const sameEntries = (actual: unknown, expected: Record<string, string>) => {
  const entries = Object.entries((actual ?? {}) as Record<string, unknown>);
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(([key, value]) => expected[key] === value)
  );
};

/**
 * A token for this repository with `permissions` (contents and/or pull
 * requests write). Throws unless the installation and the token are exactly
 * as narrow as described above.
 */
export async function installationToken(
  config: AgentAppConfig,
  permissions: Permissions,
  fetchImpl: Fetch = (...args) => fetch(...args),
  nowMs: number = Date.now(),
): Promise<string> {
  if (Object.keys(permissions).length === 0)
    throw new AgentAppConfigError("No permissions requested");
  const jwt = createAppJwt(config.appId, config.privateKey, nowMs);
  mask(jwt);
  let installation: Record<string, unknown>;
  try {
    installation = await call(
      fetchImpl,
      "apps.getRepoInstallation",
      `/repos/${config.repo}/installation`,
      jwt,
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new AgentAppConfigError("The agent App isn't installed on this repository");
    }
    if (error instanceof GitHubApiError && error.status === 401) {
      throw new AgentAppConfigError(
        "GitHub rejected the agent App's credentials; check AGENT_APP_ID and the key",
      );
    }
    throw error;
  }
  if (typeof installation.id !== "number") throw new GitHubApiError("apps.getRepoInstallation", 0);
  if (installation.repository_selection !== "selected") {
    throw new AgentAppConfigError("The agent App must be installed on selected repositories only");
  }
  if (!sameEntries(installation.permissions, AGENT_PERMISSIONS)) {
    throw new AgentAppConfigError(
      "The agent App must have exactly Contents and Pull requests write (plus Metadata read), and nothing else",
    );
  }

  const [, name] = config.repo.split("/");
  const granted = await call(
    fetchImpl,
    "apps.createInstallationAccessToken",
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    "POST",
    { repositories: [name], permissions },
  );
  const token = granted.token;
  if (typeof token !== "string" || !token)
    throw new GitHubApiError("apps.createInstallationAccessToken", 0);
  mask(token);
  const repositories = Array.isArray(granted.repositories)
    ? (granted.repositories as Record<string, unknown>[])
    : [];
  const onlyThisRepo =
    granted.repository_selection === "selected" &&
    repositories.length === 1 &&
    String(repositories[0]?.full_name).toLowerCase() === config.repo.toLowerCase();
  if (!onlyThisRepo || !sameEntries(granted.permissions, { ...permissions, metadata: "read" })) {
    // The token we least want around: revoke it at once.
    await revokeToken(token, fetchImpl);
    throw new AgentAppConfigError(
      "The agent App token isn't limited to this repository and the requested permissions",
    );
  }
  return token;
}

/** Revoke a token once the job is done (best effort; it expires within an hour anyway). */
export async function revokeToken(
  token: string,
  fetchImpl: Fetch = (...args) => fetch(...args),
): Promise<void> {
  await call(
    fetchImpl,
    "apps.revokeInstallationAccessToken",
    "/installation/token",
    token,
    "DELETE",
  ).catch(() => {});
}
