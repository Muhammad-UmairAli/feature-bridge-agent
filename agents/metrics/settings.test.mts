// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readMetricsSettings } from "./settings.mts";

const env = {
  GITHUB_REPOSITORY: "octo/requests",
  GITHUB_TOKEN: "fake-github-token-for-tests",
  PORTAL_BOT_LOGIN: "portal[bot]",
  AGENT_APP_LOGIN: "coder-app[bot]",
};

describe("readMetricsSettings", () => {
  it("reads the settings and defaults the window to 90 days", () => {
    expect(readMetricsSettings(env)).toEqual({
      repo: "octo/requests",
      token: "fake-github-token-for-tests",
      portalBotLogin: "portal[bot]",
      agentAppLogin: "coder-app[bot]",
      days: 90,
    });
  });

  it("accepts a window from 1 to 365 days, blank meaning the default", () => {
    expect(readMetricsSettings({ ...env, METRICS_DAYS: "30" }).days).toBe(30);
    expect(readMetricsSettings({ ...env, METRICS_DAYS: "365" }).days).toBe(365);
    expect(readMetricsSettings({ ...env, METRICS_DAYS: " " }).days).toBe(90);
  });

  it("refuses an unusable window", () => {
    for (const days of ["0", "366", "-5", "1.5", "ten", "30; rm"]) {
      expect(() => readMetricsSettings({ ...env, METRICS_DAYS: days })).toThrow("METRICS_DAYS");
    }
  });

  it("names the missing setting, never a value", () => {
    for (const name of Object.keys(env)) {
      const broken = { ...env, [name]: "" };
      expect(() => readMetricsSettings(broken)).toThrow(name);
    }
  });

  it("refuses malformed names and does not echo them", () => {
    for (const [name, value] of [
      ["GITHUB_REPOSITORY", "octo/requests/../x"],
      ["PORTAL_BOT_LOGIN", "portal bot\n::error::x"],
      ["AGENT_APP_LOGIN", "-bad"],
    ] as const) {
      const attempt = () => readMetricsSettings({ ...env, [name]: value });
      expect(attempt).toThrow(name);
      expect(attempt).not.toThrow(value);
    }
  });
});
