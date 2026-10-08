# Agents

Automation scripts that run in GitHub Actions: planning a request, implementing an
approved plan, and reviewing the resulting pull request.

They are TypeScript `.mts` files that Node 24 runs directly (type stripping), so they
use relative imports with explicit `.mts` extensions and can't import from `src/` via
`@/*`. Keep them free of syntax that needs compiling (no enums, namespaces or
parameter properties); `pnpm typecheck` enforces this.

| Path                | What it does                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| `lib/llm.mts`       | Calls any OpenAI-compatible chat endpoint, with a token budget per agent run |
| `lib/allowlist.mts` | Decides whether a GitHub account may approve or steer the agents             |
| `lib/github.mts`    | The few GitHub REST calls the agents make with the workflow token            |
| `planner/`          | Planning agent: posts an implementation plan on new portal requests          |

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

Screenshots are sent to the model only when `LLM_IMAGE_INPUT` is `on` (the model must
accept images) and the stored file still exists.
