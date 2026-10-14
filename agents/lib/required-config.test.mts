// @vitest-environment node
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { missingConfig } from "./required-config.mts";

describe("missingConfig", () => {
  it("names each missing setting and where it goes", () => {
    expect(missingConfig(["llm", "app"], {})).toEqual({
      ok: true,
      missing: [
        "LLM_BASE_URL (repository variable)",
        "LLM_MODEL (repository variable)",
        "LLM_API_KEY (secret in the agents environment)",
        "AGENT_APP_ID (variable in the agent-app environment)",
        "AGENT_APP_PRIVATE_KEY (secret in the agent-app environment)",
      ],
    });
  });

  it("reads secrets only as present-or-not flags, and ignores blank values", () => {
    const env = {
      LLM_BASE_URL: "https://example.test/v1",
      LLM_MODEL: "  ",
      LLM_API_KEY: "a key passed by mistake",
      HAS_LLM_API_KEY: "false",
    };
    expect(missingConfig(["llm"], env)).toEqual({
      ok: true,
      missing: [
        "LLM_MODEL (repository variable)",
        "LLM_API_KEY (secret in the agents environment)",
      ],
    });
    expect(
      missingConfig(["llm"], { ...env, LLM_MODEL: "provider/model", HAS_LLM_API_KEY: "true" }),
    ).toEqual({ ok: true, missing: [] });
  });

  it("lists a setting once when a group is repeated", () => {
    expect(missingConfig(["app", "app"], { AGENT_APP_ID: "1" })).toEqual({
      ok: true,
      missing: ["AGENT_APP_PRIVATE_KEY (secret in the agent-app environment)"],
    });
  });

  it("refuses an empty or unknown list of groups", () => {
    expect(missingConfig([], {})).toEqual({ ok: false, unknown: [] });
    expect(missingConfig(["llm", "toString"], {})).toEqual({ ok: false, unknown: ["toString"] });
  });
});

describe("check-config.mts", () => {
  const run = (env: Record<string, string>) =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./check-config.mts", import.meta.url))],
      { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env } },
    );
  const fails = async (env: Record<string, string>) =>
    (await run(env).catch((error: unknown) => error)) as { code: number; stderr: string };

  it("fails with one annotation naming what's missing", async () => {
    const failure = await fails({ CONFIG_NEEDS: "app", AGENT_APP_ID: "123" });
    expect(failure.code).toBe(1);
    expect(failure.stderr.trim()).toBe(
      '::error::This job isn\'t configured. Missing: AGENT_APP_PRIVATE_KEY (secret in the agent-app environment). See the README section "Running your own copy".',
    );
  });

  it("names every missing setting across groups, with a blank value counted as missing", async () => {
    const failure = await fails({ CONFIG_NEEDS: "llm, app", AGENT_APP_ID: "  " });
    expect(failure.code).toBe(1);
    expect(failure.stderr.trim().split("\n")).toHaveLength(1);
    for (const name of [
      "LLM_BASE_URL",
      "LLM_MODEL",
      "LLM_API_KEY",
      "AGENT_APP_ID",
      "AGENT_APP_PRIVATE_KEY",
    ]) {
      expect(failure.stderr).toContain(name);
    }
  });

  it("refuses an empty list, and echoes an unknown group without workflow-command characters", async () => {
    const empty = await fails({});
    expect(empty.code).toBe(1);
    expect(empty.stderr.trim()).toBe("::error::CONFIG_NEEDS must list known groups (llm, app).");

    const unknown = await fails({ CONFIG_NEEDS: "llm %0A::warning::x" });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr.trim()).toBe(
      "::error::CONFIG_NEEDS must list known groups (llm, app); unknown: ?0A??warning??x.",
    );
  });

  it("passes when everything is there", async () => {
    const { stdout } = await run({
      CONFIG_NEEDS: "app",
      AGENT_APP_ID: "123",
      HAS_AGENT_APP_PRIVATE_KEY: "true",
    });
    expect(stdout.trim()).toBe("Configuration present.");
  });
});

describe("workflows", () => {
  // Text-level scan (no YAML parser is a dependency): every job that passes
  // a key to a step must run the configuration check for it first.
  const dir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const keys = [
    { secret: "LLM_API_KEY", group: "llm" },
    { secret: "AGENT_APP_PRIVATE_KEY", group: "app" },
  ];

  it("check configuration before any job uses the model key or the App key", () => {
    let checked = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
      const text = readFileSync(`${dir}${file}`, "utf8");
      const jobs = (text.split(/^jobs:\s*$/m)[1] ?? "").split(/^ {2}(?=[a-z][\w-]*:\s*$)/m);
      for (const job of jobs) {
        for (const { secret, group } of keys) {
          // A use is `${{ secrets.X }}`; the check passes `${{ secrets.X != '' }}`.
          const use = job.search(new RegExp(`secrets\\.${secret}\\s*\\}\\}`));
          if (use === -1) continue;
          const check = job.indexOf(`CONFIG_NEEDS: ${group}\n`);
          expect(check, `${file}: ${secret} is used without a ${group} check`).toBeGreaterThan(-1);
          expect(
            check,
            `${file}: the ${group} check must come before ${secret} is used`,
          ).toBeLessThan(use);
          checked += 1;
        }
      }
    }
    // Six key-holding jobs today; a lower count means the scan stopped matching.
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});
