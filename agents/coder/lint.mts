/**
 * Lints proposed demo files with the repository's own ESLint config before
 * they are committed. Linting parses the code but never runs it, but ESLint's
 * own plugins do run, so the build calls this only in a job without secrets
 * (from the default branch's checkout, so the config can't come from a request).
 */
import { shown } from "../scope-check/check.mts";
import type { GeneratedFile } from "./files.mts";

export async function lintFiles(
  files: GeneratedFile[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const { ESLint } = await import("eslint");
  // The repository's own config file, never one looked up per linted path.
  const eslint = new ESLint({ cwd, overrideConfigFile: `${cwd}/eslint.config.mjs` });
  const problems: string[] = [];
  for (const file of files) {
    const [result] = await eslint.lintText(file.content, { filePath: file.path });
    for (const message of result?.messages ?? []) {
      // Rule ids and positions only: messages can quote the code.
      problems.push(
        `${shown(file.path)}: lint ${message.ruleId ?? (message.fatal ? "parse error" : "problem")} at line ${message.line}`,
      );
    }
  }
  return problems;
}
