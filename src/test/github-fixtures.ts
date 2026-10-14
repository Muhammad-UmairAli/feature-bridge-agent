// Test helpers for GitHub App code: a throwaway RSA key and a fake API.
import { generateKeyPairSync } from "node:crypto";

import { vi } from "vitest";

import type { GitHubAppConfig } from "@/lib/config";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_PRIVATE_KEY = keys.privateKey;
export const TEST_PUBLIC_KEY = keys.publicKey;

export const TEST_APP_CONFIG: GitHubAppConfig = {
  appId: 123,
  installationId: 456,
  privateKey: TEST_PRIVATE_KEY,
  owner: "octo-org",
  repo: "requests",
};

export const INSTALLATION_TOKEN = "fake-installation-token-for-tests";

type Route = (init: RequestInit) => Response | Promise<Response>;

/** A fetch stand-in that answers by "METHOD path" and records every call. */
export function fakeGitHub(routes: Record<string, Route>) {
  return vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const route = routes[`${init.method ?? "GET"} ${path}`];
    if (!route) return new Response("not found", { status: 404 });
    return route(init);
  });
}

export const tokenRoute: Route = () =>
  Response.json(
    { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    { status: 201 },
  );
