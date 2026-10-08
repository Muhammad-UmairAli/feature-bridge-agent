// @vitest-environment node
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_PERMISSIONS,
  AgentAppConfigError,
  createAppJwt,
  installationToken,
  readAgentAppConfig,
  revokeToken,
} from "./app-auth.mts";
import { GitHubApiError } from "./github.mts";

// Throwaway keys generated for the test run.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const env = { AGENT_APP_ID: "123", AGENT_APP_PRIVATE_KEY: pem, GITHUB_REPOSITORY: "octo/requests" };

afterEach(() => vi.unstubAllEnvs());

describe("readAgentAppConfig", () => {
  it("reads the App id, key and repository, keeping the key out of serialised output", () => {
    const config = readAgentAppConfig(env);
    expect(config).toMatchObject({ appId: 123, repo: "octo/requests" });
    expect(config.privateKey.type).toBe("private");
    expect(JSON.stringify(config)).not.toContain("PRIVATE");
  });

  it("accepts GitHub's PKCS#1 download format and escaped newlines", () => {
    expect(readAgentAppConfig({ ...env, AGENT_APP_PRIVATE_KEY: pkcs1 }).appId).toBe(123);
    expect(
      readAgentAppConfig({ ...env, AGENT_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }).appId,
    ).toBe(123);
  });

  it("removes the key from the process environment once read", () => {
    vi.stubEnv("AGENT_APP_ID", "123");
    vi.stubEnv("AGENT_APP_PRIVATE_KEY", pem);
    vi.stubEnv("GITHUB_REPOSITORY", "octo/requests");
    readAgentAppConfig();
    expect(process.env.AGENT_APP_PRIVATE_KEY).toBeUndefined();
  });

  it("names what's missing or invalid without printing values", () => {
    expect(() => readAgentAppConfig({})).toThrow(
      "Missing configuration: AGENT_APP_ID, AGENT_APP_PRIVATE_KEY, GITHUB_REPOSITORY",
    );
    expect(() => readAgentAppConfig({ ...env, AGENT_APP_ID: "abc" })).toThrow("must be a number");
    expect(() => readAgentAppConfig({ ...env, AGENT_APP_PRIVATE_KEY: "not a key" })).toThrow(
      "isn't a valid private key",
    );
    expect(() => readAgentAppConfig({ ...env, GITHUB_REPOSITORY: "a/b/c" })).toThrow("owner/name");
  });

  it("refuses keys that aren't RSA or are too short", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
    for (const key of [ec, small]) {
      const text = key.export({ type: "pkcs8", format: "pem" }).toString();
      expect(() => readAgentAppConfig({ ...env, AGENT_APP_PRIVATE_KEY: text })).toThrow(
        "RSA key of at least 2048 bits",
      );
    }
  });
});

describe("createAppJwt", () => {
  it("signs a short-lived RS256 token for the App", () => {
    const now = Date.UTC(2026, 9, 8);
    const jwt = createAppJwt(123, privateKey, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 120, iss: "123" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(privateKey), Buffer.from(signature, "base64url"))).toBe(
      true,
    );
  });
});

describe("installationToken", () => {
  const config = readAgentAppConfig(env);
  const wanted = { contents: "write", pull_requests: "write" } as const;
  const goodToken = {
    token: "fake-installation-token-for-tests",
    permissions: { ...wanted, metadata: "read" },
    repository_selection: "selected",
    repositories: [{ full_name: "octo/requests" }],
  };

  function github(installation: Record<string, unknown> = {}, token: Record<string, unknown> = {}) {
    return vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/octo/requests/installation")) {
        return Response.json({
          id: 42,
          repository_selection: "selected",
          permissions: AGENT_PERMISSIONS,
          ...installation,
        });
      }
      if (url.endsWith("/app/installations/42/access_tokens"))
        return Response.json({ ...goodToken, ...token });
      return new Response("", { status: 404 });
    });
  }

  it("asks for a token limited to this repository and the given permissions, and masks it", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = github();
    expect(await installationToken(config, wanted, fetchMock)).toBe(
      "fake-installation-token-for-tests",
    );
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      repositories: ["requests"],
      permissions: wanted,
    });
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
    expect(log).toHaveBeenCalledWith("::add-mask::fake-installation-token-for-tests");
    expect(log.mock.calls.some(([line]) => String(line).startsWith("::add-mask::ey"))).toBe(true);
    log.mockRestore();
  });

  it.each([
    [
      "holds Workflows",
      { permissions: { ...AGENT_PERMISSIONS, workflows: "write" } },
      "exactly Contents and Pull requests",
    ],
    [
      "lacks a permission",
      { permissions: { contents: "write", metadata: "read" } },
      "exactly Contents and Pull requests",
    ],
    [
      "is installed on all repositories",
      { repository_selection: "all" },
      "selected repositories only",
    ],
  ])(
    "refuses an installation that %s, before asking for a token",
    async (_name, installation, message) => {
      const fetchMock = github(installation);
      await expect(installationToken(config, wanted, fetchMock)).rejects.toThrow(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "an extra permission",
      { permissions: { ...wanted, metadata: "read", repository_hooks: "write" } },
    ],
    [
      "a second repository",
      { repositories: [{ full_name: "octo/requests" }, { full_name: "octo/other" }] },
    ],
    ["another repository", { repositories: [{ full_name: "octo/other" }] }],
    ["all repositories", { repository_selection: "all" }],
  ])("refuses and revokes a token with %s", async (_name, token) => {
    const fetchMock = github({}, token);
    await expect(installationToken(config, wanted, fetchMock)).rejects.toBeInstanceOf(
      AgentAppConfigError,
    );
    const revoke = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/installation/token") && init?.method === "DELETE",
    );
    expect((revoke?.[1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer fake-installation-token-for-tests",
    );
  });

  it("refuses an empty permission request", async () => {
    await expect(installationToken(config, {}, github())).rejects.toThrow(
      "No permissions requested",
    );
  });

  it("explains a missing installation or rejected credentials", async () => {
    for (const [status, message] of [
      [404, "isn't installed on this repository"],
      [401, "check AGENT_APP_ID and the key"],
    ] as const) {
      const failing = vi.fn<typeof fetch>(async () => new Response("", { status }));
      await expect(installationToken(config, wanted, failing)).rejects.toThrow(message);
    }
  });

  it("reports other failures by operation and status, never echoing a body", async () => {
    const unreadable = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/installation")
        ? Response.json({
            id: 42,
            repository_selection: "selected",
            permissions: AGENT_PERMISSIONS,
          })
        : new Response("{ token: fake-installation-token", { status: 201 }),
    );
    const error = await installationToken(config, wanted, unreadable).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as Error).message).toBe(
      "GitHub apps.createInstallationAccessToken failed with 0",
    );
  });
});

describe("revokeToken", () => {
  it("deletes the token and ignores failures", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await revokeToken("fake-token", fetchMock);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.github.com/installation/token");
    await expect(
      revokeToken(
        "fake-token",
        vi.fn<typeof fetch>(async () => new Response("", { status: 500 })),
      ),
    ).resolves.toBeUndefined();
  });
});
