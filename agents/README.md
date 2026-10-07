# Agents

Automation scripts that run in GitHub Actions: planning a request, implementing an
approved plan, and reviewing the resulting pull request.

They are TypeScript `.mts` files that Node 24 runs directly (type stripping), so they
use relative imports with explicit `.mts` extensions and can't import from `src/` via
`@/*`. Keep them free of syntax that needs compiling (no enums, namespaces or
parameter properties); `pnpm typecheck` enforces this.

| Path          | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `lib/llm.mts` | Calls any OpenAI-compatible chat endpoint, with a token budget per agent run |

## Model configuration

| Name                         | Where                   | Notes                                                                            |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `LLM_BASE_URL`               | Actions variable        | OpenAI-compatible API base, `https://` only, e.g. `https://openrouter.ai/api/v1` |
| `LLM_MODEL`                  | Actions variable        | Model id as the provider names it                                                |
| `LLM_API_KEY`                | Actions secret          | Provider API key                                                                 |
| `LLM_MAX_TOKENS_PER_REQUEST` | Actions variable (opt.) | Token budget for one agent run, prompt plus reply (default 50,000)               |

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
