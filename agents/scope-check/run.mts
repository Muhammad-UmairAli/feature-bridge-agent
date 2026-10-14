/**
 * Write-scope check entry point. Runs on `pull_request_target` from the base
 * branch's code, with the pull request's commits fetched as data only; no
 * secrets and a read-only token.
 *
 * Environment (from the event): HEAD_REF, HEAD_REPO, BASE_REPO, BASE_REF,
 * PR_AUTHOR, BASE_SHA, HEAD_SHA, and the AGENT_APP_LOGIN repository variable.
 */
import { createGit, checkPullRequest } from "./pull-request.mts";

async function main(): Promise<number> {
  const env = (name: string) => process.env[name]?.trim() ?? "";
  const result = await checkPullRequest(
    {
      headRef: env("HEAD_REF"),
      headRepo: env("HEAD_REPO"),
      baseRepo: env("BASE_REPO"),
      baseRef: env("BASE_REF"),
      author: env("PR_AUTHOR"),
      agentLogin: env("AGENT_APP_LOGIN"),
    },
    env("BASE_SHA"),
    env("HEAD_SHA"),
    createGit(process.cwd()),
  );
  if (result.skipped) {
    console.log("Not a request branch; nothing to check.");
    return 0;
  }
  if (result.problems.length > 0) {
    // The summary first: annotations are capped per step.
    console.error(`::error::${result.problems.length} problem(s) in this request pull request.`);
    for (const problem of result.problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log(`Checked ${result.checked} change(s): all inside the request's demo folder.`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Fixed text: git's own error output could carry untrusted file names.
    console.error("::error::The write-scope check couldn't read the pull request's commits.");
    process.exitCode = 1;
  },
);
