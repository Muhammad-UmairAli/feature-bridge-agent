/**
 * Build job 2 entry point: lint the generated demo (GitHub Actions, Node 24).
 *
 * Runs with no secrets and a read-only token, because ESLint's plugins run
 * here. Environment: BUNDLE and BUNDLE_SHA256 from the generate job. Exits
 * non-zero (the workflow then hands the request to a maintainer) on any
 * lint problem; logs rule ids and quoted paths only.
 */
import { runCheck } from "./build.mts";
import { lintFiles } from "./lint.mts";

async function main(): Promise<number> {
  const problems = await runCheck(
    process.env.BUNDLE ?? "",
    process.env.BUNDLE_SHA256 ?? "",
    (files) => lintFiles(files, process.cwd()),
  );
  if (problems.length > 0) {
    console.error(`::error::${problems.length} problem(s) in the generated demo.`);
    for (const problem of problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log("The generated demo passes the repository's lint rules.");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error("::error::The generated demo couldn't be linted.");
    process.exitCode = 1;
  },
);
