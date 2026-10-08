# Agents

Automation scripts that run in GitHub Actions: planning a request, implementing an
approved plan, and reviewing the resulting pull request.

They are TypeScript `.mts` files that Node 24 runs directly (type stripping), so they
use relative imports with explicit `.mts` extensions and can't import from `src/` via
`@/*`. Keep them free of syntax that needs compiling (no enums, namespaces or
parameter properties); `pnpm typecheck` enforces this.

| Path                | What it does                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `lib/llm.mts`       | Calls any OpenAI-compatible chat endpoint, with a token budget per agent run                                     |
| `lib/allowlist.mts` | Decides whether a GitHub account may approve or steer the agents                                                 |
| `lib/github.mts`    | The few GitHub REST calls the agents make with the workflow token                                                |
| `planner/`          | Planning agent: posts an implementation plan on new portal requests                                              |
| `gate/`             | Approval gate: checks an `approved-by-human` label before anything is built                                      |
| `coder/`            | Coding agent: turns an approved plan into a demo, publishes it as a pull request, and revises it once on request |
| `scope-check/`      | CI check that agent pull requests only change their demo folder                                                  |
| `reviewer/`         | Automated, advisory review of the coding agent's pull requests                                                   |

## Model configuration

| Name                         | Where                              | Notes                                                                            |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `LLM_BASE_URL`               | Actions variable                   | OpenAI-compatible API base, `https://` only, e.g. `https://openrouter.ai/api/v1` |
| `LLM_MODEL`                  | Actions variable                   | Model id as the provider names it                                                |
| `LLM_API_KEY`                | Secret in the `agents` environment | Provider API key; no repository- or organization-level secret with this name     |
| `LLM_MAX_TOKENS_PER_REQUEST` | Actions variable (opt.)            | Token budget for one agent run, prompt plus reply (default 50,000)               |

Before each call the adapter reserves its worst case (estimated prompt plus the reply
limit) and refuses the call if that doesn't fit; afterwards it counts the reported usage,
or keeps the full reservation when usage is unknown. Prompt sizes are estimated, so the
last call of a run can overshoot slightly. A run that reaches its budget stops and hands
the request to a human. Missing or invalid settings stop a run before any call is made;
error messages name the setting, never its value.

The adapter sends `max_tokens`, so endpoints that only accept `max_completion_tokens`
aren't supported. Run the agents on GitHub-hosted runners: the key is sent to whatever
`LLM_BASE_URL` points at.

## Approver allowlist

`APPROVER_ALLOWLIST` (Actions variable) lists the GitHub usernames whose approvals,
plan feedback and reviews the agents act on: comma or whitespace separated, `@`
optional, case-insensitive. Only accounts of type `User` match; bots, organizations,
`ghost` and anything that isn't a valid GitHub username never do. A missing or empty
list allows nobody, so a fork does nothing until its owner sets it. The workflows also
check that the account still has triage access to the repository, because usernames can
be freed and registered again.

## Planning agent

`planner/run.mts` plans one request issue (`ISSUE_NUMBER`). It acts only on open issues
created by the portal's bot account (`PORTAL_BOT_LOGIN`, e.g. `your-app[bot]`) with the
`portal-request` label, and only once per issue. The description is read from the
issue's fenced block and given to the model as delimited data, never as instructions,
along with `AGENTS.md` and the list of files under `src/`. The demo folder is
`src/app/demos/request-<issue number>/`, assigned by the workflow.

The plan is posted as one comment with every generated word inside a text fence, so it
can't mention users, link issues or add formatting. Labels move from `planning` to
`plan-ready`. If anything fails, including running out of token budget, the agent posts
a short fixed comment and applies `needs-human-triage` instead. Runs for the same issue must
not overlap; the workflow serialises them per issue.

Plans that can't stay inside the demo folder go to a maintainer instead. The agent checks
every listed file against the allowed demo files, scans the plan text for other paths,
URLs, dependency installs, configuration, environment variables and network calls, and
asks the model whether the request needs a dependency, an integration, auth changes or
stored data. If anything is flagged, or the request text tried to instruct the agent, the
plan is still posted with a note explaining why, and the issue gets `needs-human-triage`
instead of `plan-ready`. This is a triage signal; the build and CI check what actually
changes.

When a maintainer applies `changes-requested`, the workflow runs the agent in revise mode
(`PLANNER_MODE=revise`). The agent reads who last applied the label from the issue's
history (so re-running an old run can't replay an old sender) and acts only if that
account is on `APPROVER_ALLOWLIST`, is a user and still has triage access; otherwise it
removes the label. It gives the model the previous plan, as data, and the feedback: comments
from allowlisted users with access, posted after the latest plan and before the label, and
not edited since. Hidden HTML comments and quoted lines are left out, so the model sees
what the maintainer saw. With no such comment, the agent asks for one and removes the
label. The second time a plan is sent back, or after a failed revision, the request goes to
a maintainer instead. Before posting any plan, the agent re-reads the labels and posts
nothing if the request was approved or handed over in the meantime.

Screenshots are sent to the model only when `LLM_IMAGE_INPUT` is `on` (the model must
accept images) and the stored file still exists.

## Approval gate

`gate/run.mts` runs when someone applies `approved-by-human`. It reads the issue's current
state rather than the triggering event (re-runs replay that), and accepts the approval
only if all of these hold:

- whoever last applied the label (from the issue's event history) is on
  `APPROVER_ALLOWLIST`, is a user, has triage access or higher, and isn't the issue author;
- the request has `plan-ready`, with no `changes-requested`, `planning` or
  `needs-human-triage`, and the label history shows no new drafting or hand-over since
  the plan was posted;
- the latest plan from the planning agent was posted before the approval (not in the same
  second), was never edited, was marked ready when posted, isn't followed by a "planning
  stopped" comment, was made from the current request text and screenshot link, and still
  passes the demo-area checks;
- the approval hasn't already been used for a build.

Otherwise it removes the label and explains why in a fixed comment; if the check itself
fails or is cancelled, the workflow removes the label so it can be applied again. An
accepted approval gives the build job the approval's event id, the plan comment's id and a
SHA-256 of the approved plan text, which the build re-verifies before using.

Known limit: every workflow in this repository comments as the same bot, so anyone who
can push a workflow (write access) could post a plan comment the gate would accept. Keep
write access to people you'd trust to approve.

## Write-scope check

The "Write scope" workflow (`scope-check/`) runs on `pull_request_target`, so the job and
the checker come from the base branch and a pull request can't change the check it is
judged by. The pull request's commits are fetched as git objects only; nothing from them
is checked out or run, and the job has no secrets.

- A request branch must be named exactly `request-<number>`, come from this repository,
  target `main`, and be opened by the coding agent (`AGENT_APP_LOGIN`). The agent may not
  open pull requests from any other branch.
- Every file touched by every commit, deletions and both sides of renames included, must
  be an allowed file in a new `src/app/demos/request-<number>/` folder (checked by two
  independent rules). Merge commits, symlinks, submodules and executable files are
  refused.
- Every added file must be UTF-8 text under 100 KB (1 MB in total) without control,
  bidi or zero-width characters, and without lint or type-check suppressions.

ESLint rules for `src/app/demos/**` flag common forms of environment access, Node APIs,
network calls, other windows, server actions, injected HTML, `eval`, dynamic imports and
redirects, allow imports only from `@/components/ui/*`, `@/lib/utils` and the demo's own
files, and can't be switched off inline. They help reviewers; they aren't a security
boundary on their own. Make "Write scope" and the CI checks required on `main`.

## Coding agent

`coder/generate.mts` turns an approved plan into the files of a new demo. Demo code never
runs on the server or during the build: the workflow writes `page.tsx` (title and heading
only) and `demo-loader.tsx` (mounts `demo.tsx` in the browser with `next/dynamic` and
`ssr: false`) from fixed templates (`coder/template.mts`), and the write-scope check in CI
compares both with the templates exactly. The model writes `demo.tsx`, helpers and tests.

The model gets `AGENTS.md`, the shared UI sources and the approved plan as delimited data
(the request text itself isn't sent; plans containing code or markers go to a human), and
answers with each file between `<<<FILE path>>>` and `<<<END FILE>>>` lines, or
`<<<CANNOT BUILD>>>`. Every file is then checked before it is committed: allowed paths and
sizes, a `"use client"` default export in `demo.tsx`, at least one test, an import allowlist,
literal browser storage keys prefixed `demo:<slug>:`, plain text without hidden characters,
escapes or very long lines, only simple `vi` helpers in tests, and the AGENTS.md "not
allowed" list; then the repository's own ESLint rules run on the files (parsing, never
running them). A failing answer gets one retry with the problems listed; after that, the
build stops for a human. These checks are tripwires; isolation, CI and human review are the
real controls.

`coder/publish.mts` then publishes the files as the coding agent's own GitHub App
(`lib/app-auth.mts`: RS256 app JWT with `node:crypto`). Before minting a token it checks
that the App's installation covers selected repositories only and holds exactly contents
and pull requests write plus metadata read; the token must then name this repository only
and carry only what was asked for. Credentials are masked in the logs and the key is
removed from the process environment once read. Publishing checks the files again (the
model's files and both templates), creates branch `request-<number>` from `main` with one
commit through the Git Data API, and opens a pull request into `main` with fixed text. It
never force-updates or deletes anything; lost responses are recovered by looking again,
and anything else is left for a maintainer.

### The build jobs

`coder/run-generate.mts`, `coder/run-check.mts` and `coder/run-publish.mts` run as jobs of
the "Build request" workflow after the gate accepts an approval:

- Generate (model key only, Node's standard library only) re-verifies the approval without
  side effects, posts the build record (`gate.buildMarker`) before any model call, generates
  the demo, and passes the files on as a gzip + base64 bundle tied to the approval and plan,
  with its SHA-256.
- Check (no secrets, read-only token) lints the files with the repository's ESLint rules;
  ESLint's plugins never run next to a key.
- Publish (agent App key only, nothing installed) checks the bundle and the approval again,
  publishes, comments with the pull request number, and revokes its token.

Both key-holding jobs refuse re-runs. A withdrawn or superseded approval stops quietly;
anything else posts a fixed comment and applies `escalated-to-human`, and a crashed or
cancelled job is handed over by a final plain-`gh` step. The gate refuses new approvals
while `escalated-to-human` is on the request.

### Revisions and circuit breakers

`coder/revise.mts` revises a request pull request when someone applies `changes-requested`
to it ("Revise request" workflow, `pull_request_target`, base-branch code). The gate job
(no secrets) re-reads the pull request: it must be the coding agent's open `request-<number>`
pull request, the latest `changes-requested` label must come from someone on
`APPROVER_ALLOWLIST` with triage access, and the pull request must not have
`escalated-to-human`. The first change request is revised; the next one goes to a maintainer
(FR-16). Feedback is what allowlisted maintainers wrote on the pull request before the label:
review summaries, inline review comments (with their file and line) and comments, unedited
since (review summaries have no edit time), with quoted lines and hidden HTML removed. With
no feedback, the agent asks for it and removes the label.

The generate job (model key) checks again, records the round on the pull request before any
model call (so a failed revision still counts), reads the demo's current files as git
objects at the reviewed commit, and asks the model for the complete new file set from the
approved plan, the current files (as data) and the feedback. The build's lint job checks the
files, and the publish job (agent App key) checks again and pushes one commit whose parent is
exactly the reviewed commit (`publish.pushRevision`: files left out are deleted from the demo
folder; the branch is never force-updated, so if it moved, nothing is pushed). Every job hands
the pull request to a maintainer if it can't finish. Removing the label while a revision
runs cancels it with a short comment, but the round still counts (it was recorded before the
model call), so the next change request goes to a maintainer. An unchanged demo isn't pushed.

`coder/breaker.mts` runs after every failed CI run on a request branch ("CI breaker",
`workflow_run`, no secrets). It counts the latest CI runs for pull requests on that branch:
failures (or timeouts) in a row, back to the last passing run, with cancelled and skipped
runs ignored and only this repository's runs counted (forks can reuse branch names). It
counts runs, not commits: CI re-triggered on the same commit counts again. At two, the pull request gets `escalated-to-human` and a fixed comment, and the
revision jobs refuse it from then on.

## Automated review

`reviewer/run.mts` runs in the "Review request" workflow for every commit pushed to a pull
request the coding agent opened (`request-<number>` into `main`, by `AGENT_APP_LOGIN`,
from this repository; other pull requests get no job). Like the write-scope check it runs
on `pull_request_target` from the base branch's code and reads the head commit as git
objects only; it holds the model key, so it installs nothing.

It gives the model `AGENTS.md` (trusted), the plan the build was made from (the planning
agent's last plan before its last build record on the request issue, unedited) and the
demo's own files at the head (`demo.tsx`, helpers and tests; the page and loader are
templates the write-scope check compares exactly), with the plan and files as delimited
data. Folders holding anything the write-scope rules don't allow, or more than 64 KB of
files, aren't sent. The model answers with a JSON verdict (`pass` or `findings`, a
summary and findings), which is cleaned and posted as one comment with every generated
word inside a text fence, under a hidden marker with the result and the commit. The comment
also lists what the coding agent's own file checks (`coder/files.mts`) find at that commit,
which the files can't steer; any problem there makes the result `findings`.

The review is advisory. It approves nothing and changes nothing: findings wait for a
maintainer, who can request changes. Each commit is reviewed once (an unedited review
comment counts); a run that couldn't finish posts a short fixed comment, fails, and can be
re-run.

Known limit: the plan is found from the request issue's latest build record. If a request
is approved again after its pull request was opened (a second build then stops because the
branch exists), later commits on the first pull request are reviewed against the newer
plan.
