/**
 * Configuration check step (GitHub Actions, Node 24, standard library only).
 * CONFIG_NEEDS lists the groups a job needs (`llm`, `app`); see
 * required-config.mts for the names each group reads. Exits non-zero, with
 * one error annotation, when anything is missing.
 */
import { missingConfig } from "./required-config.mts";

const needs = (process.env.CONFIG_NEEDS ?? "").split(/[\s,]+/).filter(Boolean);
const result = missingConfig(needs, process.env);
if (!result.ok) {
  // Unknown names are echoed with anything but word characters replaced, so
  // they can't smuggle a workflow command into the log.
  const unknown = result.unknown.map((name) => name.replace(/[^\w-]/g, "?"));
  console.error(
    `::error::CONFIG_NEEDS must list known groups (llm, app)${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}.`,
  );
  process.exitCode = 1;
} else if (result.missing.length > 0) {
  console.error(
    `::error::This job isn't configured. Missing: ${result.missing.join("; ")}. See the README section "Running your own copy".`,
  );
  process.exitCode = 1;
} else {
  console.log("Configuration present.");
}
