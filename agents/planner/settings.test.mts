// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { checkScreenshot, readPlannerSettings } from "./settings.mts";

const env = {
  GITHUB_TOKEN: "fake-token",
  GITHUB_REPOSITORY: "octo/requests",
  ISSUE_NUMBER: "7",
  PORTAL_BOT_LOGIN: "request-portal[bot]",
};

describe("readPlannerSettings", () => {
  it("reads the workflow's environment", () => {
    expect(readPlannerSettings({ ...env, LLM_IMAGE_INPUT: "on" })).toEqual({
      ok: true,
      warnings: [],
      settings: {
        token: "fake-token",
        repo: "octo/requests",
        issueNumber: 7,
        portalBotLogin: "request-portal[bot]",
        imageInput: true,
      },
    });
    const read = readPlannerSettings({ ...env, LLM_IMAGE_INPUT: "yes" });
    expect(read.ok && read.settings.imageInput).toBe(false);
  });

  it("names what's missing or invalid without printing values", () => {
    expect(readPlannerSettings({})).toEqual({
      ok: false,
      problems: [
        "GITHUB_TOKEN missing",
        "GITHUB_REPOSITORY missing",
        "ISSUE_NUMBER missing or invalid",
        "PORTAL_BOT_LOGIN missing",
      ],
    });
    for (const ISSUE_NUMBER of ["0", "0x10", "1.5", "-3", "7a", "12345678901"]) {
      expect(readPlannerSettings({ ...env, ISSUE_NUMBER }).ok).toBe(false);
    }
  });

  it("warns when the bot login can't match any app account", () => {
    const read = readPlannerSettings({ ...env, PORTAL_BOT_LOGIN: "request-portal" });
    expect(read.ok && read.warnings).toEqual([
      "PORTAL_BOT_LOGIN doesn't end in [bot], so no issue will match it",
    ]);
  });
});

describe("checkScreenshot", () => {
  const respond = (response: Response | Error) =>
    vi.fn<typeof fetch>(async () => {
      if (response instanceof Error) throw response;
      return response;
    });

  it("reports whether the stored file still exists", async () => {
    const ok = respond(new Response(null, { status: 200 }));
    expect(await checkScreenshot("https://x.test/a.png", ok)).toBe("available");
    expect(ok.mock.calls[0][1]).toMatchObject({ method: "HEAD", redirect: "error" });
    expect(await checkScreenshot("u", respond(new Response(null, { status: 404 })))).toBe(
      "missing",
    );
    expect(await checkScreenshot("u", respond(new Response(null, { status: 410 })))).toBe(
      "missing",
    );
    expect(await checkScreenshot("u", respond(new Response(null, { status: 500 })))).toBe(
      "unknown",
    );
    expect(await checkScreenshot("u", respond(new TypeError("fetch failed")))).toBe("unknown");
  });
});
