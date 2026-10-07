// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/lib/api/envelope";

import {
  DEFAULT_DAILY_SUBMISSION_CAP,
  readBlobToken,
  readBotCheckSecret,
  readDailySubmissionCap,
  readGitHubAppConfig,
} from "./config";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const githubEnv = {
  GH_APP_ID: "123",
  GH_APP_INSTALLATION_ID: "456",
  GH_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"), // as stored on one line in .env files
  REQUEST_TARGET_REPO: "octo-org/demo.repo",
};

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Asserts a generic 503 for the client, the variable name (not value) in the log. */
function expectNotConfigured(fn: () => unknown, name: string, secretValue?: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error).toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
  expect(error.message).not.toContain(name);
  const logged = errorLog.mock.calls.flat().join(" ");
  expect(logged).toContain(name);
  if (secretValue) {
    expect(error.message).not.toContain(secretValue);
    expect(logged).not.toContain(secretValue);
  }
}

describe("readGitHubAppConfig", () => {
  it("parses a complete configuration and unescapes the key", () => {
    const config = readGitHubAppConfig(githubEnv);
    expect(config).toMatchObject({
      appId: 123,
      installationId: 456,
      owner: "octo-org",
      repo: "demo.repo",
    });
    expect(config.privateKey).toBe(PEM);
  });

  it("accepts a key with real newlines", () => {
    expect(readGitHubAppConfig({ ...githubEnv, GH_APP_PRIVATE_KEY: PEM }).privateKey).toBe(
      PEM.trim(),
    );
  });

  it("fails closed on missing or malformed values", () => {
    expectNotConfigured(() => readGitHubAppConfig({ ...githubEnv, GH_APP_ID: "" }), "GH_APP_ID");
    expectNotConfigured(() => readGitHubAppConfig({ ...githubEnv, GH_APP_ID: "12x" }), "GH_APP_ID");
    expectNotConfigured(
      () => readGitHubAppConfig({ ...githubEnv, REQUEST_TARGET_REPO: "not a repo" }),
      "REQUEST_TARGET_REPO",
    );
    for (const repo of ["octo/.", "octo/.."]) {
      expectNotConfigured(
        () => readGitHubAppConfig({ ...githubEnv, REQUEST_TARGET_REPO: repo }),
        "REQUEST_TARGET_REPO",
      );
    }
  });

  it("rejects an unparseable key without echoing it", () => {
    const bogus = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----";
    expectNotConfigured(
      () => readGitHubAppConfig({ ...githubEnv, GH_APP_PRIVATE_KEY: bogus }),
      "GH_APP_PRIVATE_KEY",
      "not-a-key",
    );
  });
});

describe("readDailySubmissionCap", () => {
  it("defaults to 20 and accepts positive integers", () => {
    expect(readDailySubmissionCap({})).toBe(DEFAULT_DAILY_SUBMISSION_CAP);
    expect(readDailySubmissionCap({ DAILY_SUBMISSION_CAP: "50" })).toBe(50);
  });

  it("rejects zero, negatives and junk", () => {
    for (const value of ["0", "-1", "abc", "1.5", "99999"]) {
      expectNotConfigured(
        () => readDailySubmissionCap({ DAILY_SUBMISSION_CAP: value }),
        "DAILY_SUBMISSION_CAP",
      );
    }
  });
});

describe("secrets", () => {
  it("requires the bot check secret and Blob token", () => {
    expect(readBotCheckSecret({ BOT_CHECK_SECRET_KEY: "s" })).toBe("s");
    expect(readBlobToken({ BLOB_READ_WRITE_TOKEN: "t" })).toBe("t");
    expectNotConfigured(() => readBotCheckSecret({}), "BOT_CHECK_SECRET_KEY");
    expectNotConfigured(
      () => readBlobToken({ BLOB_READ_WRITE_TOKEN: "  " }),
      "BLOB_READ_WRITE_TOKEN",
    );
  });
});
