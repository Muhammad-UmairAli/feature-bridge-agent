/**
 * The settings a job needs, checked before it does anything else, so a copy
 * of this repository that is only partly configured stops with a message
 * naming what's missing and where it goes (never a value). Secrets are passed
 * as `HAS_<NAME>: ${{ secrets.<NAME> != '' }}`, so the check never holds them.
 */
interface Setting {
  name: string;
  where: string;
  secret?: boolean;
}

export const CONFIG_GROUPS: Record<string, Setting[]> = {
  llm: [
    { name: "LLM_BASE_URL", where: "repository variable" },
    { name: "LLM_MODEL", where: "repository variable" },
    { name: "LLM_API_KEY", where: "secret in the agents environment", secret: true },
  ],
  app: [
    { name: "AGENT_APP_ID", where: "variable in the agent-app environment" },
    {
      name: "AGENT_APP_PRIVATE_KEY",
      where: "secret in the agent-app environment",
      secret: true,
    },
  ],
};

type Env = Record<string, string | undefined>;

/** "NAME (where)" for each missing setting, or an error for an unknown group. */
export function missingConfig(
  needs: string[],
  env: Env,
): { ok: true; missing: string[] } | { ok: false; unknown: string[] } {
  const unknown = needs.filter((group) => !Object.hasOwn(CONFIG_GROUPS, group));
  if (needs.length === 0 || unknown.length > 0) return { ok: false, unknown };
  const missing = [...new Set(needs)]
    .flatMap((group) => CONFIG_GROUPS[group])
    .filter((setting) =>
      setting.secret ? env[`HAS_${setting.name}`] !== "true" : !env[setting.name]?.trim(),
    )
    .map((setting) => `${setting.name} (${setting.where})`);
  return { ok: true, missing };
}
