/** What the coding agent is shown from the trusted checkout: AGENTS.md and the shared UI sources. */
import { readFile, readdir } from "node:fs/promises";

export async function readContext() {
  const agentsGuide = await readFile("AGENTS.md", "utf8");
  const ui = (await readdir("src/components/ui")).filter((name) => /^[a-z0-9-]+\.tsx$/.test(name));
  const paths = [...ui.map((name) => `src/components/ui/${name}`), "src/lib/utils.ts"];
  const context = await Promise.all(
    paths.map(async (path) => ({ path, content: await readFile(path, "utf8") })),
  );
  return { agentsGuide, context };
}
