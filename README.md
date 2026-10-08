# feature-bridge-agent

Submit a feature request, review an AI-generated plan, and get a tested, reviewed preview of the feature.

> **Status: early development.** The app foundation, tooling and CI are in place. The request form, agents and deployments are being built next, so most of the flow below isn't live yet.

## How it works

1. Anyone describes a feature in a public web form (no login), optionally with a screenshot.
2. The request becomes a GitHub Issue, and a planning agent comments with an implementation plan and the files it would change.
3. A maintainer on the approver allowlist applies the `approved-by-human` label.
4. A coding agent implements the plan inside the demo area (`src/app/demos`), writes unit tests, and opens a pull request. An automated review runs and a preview deployment is published.
5. A human reviews and merges. Agents never merge.

Submissions are public. Don't enter confidential information, personal data or secrets.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 12, via Corepack: `corepack enable pnpm`
- A POSIX shell for the `pnpm` scripts (macOS, Linux, WSL or Git Bash)
- [pre-commit](https://pre-commit.com), for contributors (`pipx install pre-commit` or `uv tool install pre-commit`)

## Getting started

```bash
git clone https://github.com/Muhammad-UmairAli/feature-bridge-agent.git
cd feature-bridge-agent
corepack enable pnpm
pnpm install
cp .env.example .env.local   # Cloudflare test keys for the bot check are noted inside
pnpm dev                     # http://localhost:3000
```

## Scripts

| Command                             | What it does                                             |
| ----------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                          | Start the development server                             |
| `pnpm build` / `pnpm start`         | Production build / serve it                              |
| `pnpm test`                         | Run unit tests once (`pnpm test:watch`, `pnpm coverage`) |
| `pnpm lint`                         | ESLint, including accessibility rules                    |
| `pnpm typecheck`                    | TypeScript type check                                    |
| `pnpm format` / `pnpm format:check` | Prettier on every file git would commit                  |

## Configuration

Nothing secret is committed. A fork does nothing until its owner adds their own values below. Items marked _planned_ arrive with later changes, and their names may still change. For local development, put Vercel values in `.env.local` (see `.env.example`).

Set sensitive Vercel values for the **Production** environment only, never Preview: preview deployments build code from pull requests, including agent-written ones.

| Name                             | Kind                  | Where it's set                                                                                       | Purpose                                                                                                                                                                                                                            |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GH_APP_ID`                      | Variable              | Vercel (Production)                                                                                  | GitHub App the portal uses to create and read issues                                                                                                                                                                               |
| `GH_APP_INSTALLATION_ID`         | Variable              | Vercel (Production)                                                                                  | That app's installation on the target repository                                                                                                                                                                                   |
| `GH_APP_PRIVATE_KEY`             | Secret                | Vercel (Production)                                                                                  | The app's private key (PEM; paste as-is in Vercel)                                                                                                                                                                                 |
| `REQUEST_TARGET_REPO`            | Variable              | Vercel (Production)                                                                                  | Repository that receives requests (`owner/name`)                                                                                                                                                                                   |
| `NEXT_PUBLIC_BOT_CHECK_SITE_KEY` | Public key            | Vercel                                                                                               | Cloudflare Turnstile widget; built into the page, so public by design                                                                                                                                                              |
| `BOT_CHECK_SECRET_KEY`           | Secret                | Vercel (Production)                                                                                  | Server-side Turnstile verification                                                                                                                                                                                                 |
| `BOT_CHECK_HOSTNAMES`            | Variable              | Vercel (Production)                                                                                  | Comma-separated hostnames the widget may be served from. Required in production; elsewhere it defaults to the deployment or request host                                                                                           |
| `BLOB_READ_WRITE_TOKEN`          | Secret                | Vercel (Production; created when a Blob store is connected) and the `screenshot-cleanup` environment | Screenshot storage, and the daily cleanup workflow (set it in both places); update both copies when rotated                                                                                                                        |
| `DAILY_SUBMISSION_CAP`           | Variable              | Vercel (Production)                                                                                  | Max accepted submissions per UTC day (default 20, at most 1000); resets at midnight UTC                                                                                                                                            |
| `PREVIEW_HOST_SUFFIXES`          | Variable (optional)   | Vercel (Production)                                                                                  | Host suffixes trusted for preview links on the tracking page (default `.vercel.app`)                                                                                                                                               |
| `LLM_API_KEY`                    | Secret                | `agents` environment                                                                                 | Key for the model provider the agents use                                                                                                                                                                                          |
| `LLM_BASE_URL`, `LLM_MODEL`      | Variables             | Actions variables                                                                                    | Any OpenAI-compatible endpoint (`https://` only, e.g. `https://openrouter.ai/api/v1`) and the model id to call                                                                                                                     |
| `LLM_MAX_TOKENS_PER_REQUEST`     | Variable (optional)   | Actions variables                                                                                    | Token budget for one agent run (default 50,000); a run that reaches it stops for a human                                                                                                                                           |
| `LLM_IMAGE_INPUT`                | Variable (optional)   | Actions variables                                                                                    | `on` sends request screenshots to the model (it must accept images); off by default                                                                                                                                                |
| `PORTAL_BOT_LOGIN`               | Variable (repository) | Actions variables                                                                                    | The portal App's bot account (for example `your-app[bot]`, shown as the author of portal issues). Required for the agent workflows, which act only on its issues; the cleanup workflow also uses it to limit which issues it edits |
| `AGENT_APP_LOGIN`                | Variable (repository) | Actions variables                                                                                    | The coding agent App's bot account (for example `your-coder[bot]`). The "Write scope" check accepts request pull requests only from it, and refuses them until it is set                                                           |
| `APPROVER_ALLOWLIST`             | Variable (repository) | Actions variables                                                                                    | GitHub usernames (comma or space separated) whose change requests and approvals the agents act on. They also need triage access to the repository. Empty means nobody                                                              |
| `CONTENT_POLICY_PATTERNS`        | Secret                | Actions secrets                                                                                      | Private patterns for the content policy check. Required for pull requests within your own repository; pull requests from forks skip the check with a warning                                                                       |

### Setting up the GitHub App

The portal creates and reads request issues as a GitHub App, so no personal token is involved.

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New). Webhooks aren't needed: turn them off.
2. Repository permissions, nothing else:
   - **Issues:** Read and write (create request issues, read their status)
   - **Pull requests:** Read-only, and **Deployments:** Read-only (the tracking page shows linked pull requests and preview links)
   - **Metadata:** Read-only (required by GitHub)
3. Install the App with **Only select repositories**, choosing just the repository that receives requests. In that repository, create the `portal-request` label (GitHub drops labels it can't apply without an error).
4. Generate a private key, then set `GH_APP_ID`, `GH_APP_INSTALLATION_ID` (from the installation's URL), `GH_APP_PRIVATE_KEY` and `REQUEST_TARGET_REPO`.

Each call uses a short-lived installation token narrowed to that one repository and the single permission it needs.

If GitHub times out after creating an issue, the visitor sees an error and a retry can create a duplicate; maintainers can close duplicates.

### Setting up the planning agent

When the portal creates a request issue, the "Plan request" workflow posts an implementation plan on it. Like every issue-triggered workflow, it runs from the default branch, so it goes live when it reaches `main`.

1. Create the `agents` environment: Settings → Environments → New environment → Deployment branches and tags → Selected branches and tags → add `main` (which must stay the default branch). Don't add required reviewers, or every request would wait for one. If GitHub already created the environment on a first run, add the branch rule.
2. Store `LLM_API_KEY` as a secret in that environment, and make sure no repository- or organization-level secret has the same name, so only the planning step can read it.
3. Set `LLM_BASE_URL`, `LLM_MODEL` and `PORTAL_BOT_LOGIN` as repository variables (not environment variables), plus `LLM_MAX_TOKENS_PER_REQUEST` and `LLM_IMAGE_INPUT` if you want to change their defaults. These values appear in the public run logs; the key doesn't.
4. Create the labels: `portal-request` (see the GitHub App setup), `planning`, `plan-ready`, `changes-requested`, `approved-by-human` and `needs-human-triage`.
5. Use a key dedicated to this project and set a spending limit at the provider. Anyone can submit a request, and each one costs a planning run: at most `DAILY_SUBMISSION_CAP × LLM_MAX_TOKENS_PER_REQUEST` tokens a day for first plans (20 × 50,000 = 1,000,000 with the defaults), plus one revision per request that a maintainer sends back and any runs you start by hand.
6. Check the provider's data retention and training settings: it receives the request text, `AGENTS.md`, the list of files under `src/` and, with image input on, the screenshot.

To ask for a better plan, a maintainer on `APPROVER_ALLOWLIST` (with triage access or higher; custom repository roles don't count) first comments with what to change, then applies `changes-requested`. The agent posts a revised plan using only comments from allowlisted maintainers posted before the label and not edited since. A plan can be revised once: the next `changes-requested` (or a failed revision) hands the request to a maintainer (`needs-human-triage`). The label is removed again if anyone else applies it, and other people's comments are ignored.

To approve a plan, a maintainer on `APPROVER_ALLOWLIST` applies `approved-by-human` while the request shows `plan-ready`. The "Build request" workflow first checks the approval against the issue's current state (who applied it, the status labels, and that the plan is the latest, unedited one made from the current request text and within the demo-area rules); anything else removes the label with an explanation. If the check fails or is cancelled, the label is removed too; apply it again to retry.

The workflow does nothing on forks or until `PORTAL_BOT_LOGIN` is set. If a run fails (including missing settings), is cancelled or times out before the request has a status, the request gets `needs-human-triage`. To retry after fixing the cause, remove that label and re-run the failed run from the Actions tab (for a revision, the run started by `changes-requested`). Failed runs are started by the App, so GitHub may not email anyone: watch the repository's issues, or check the Actions tab.

### Screenshots and takedowns

Screenshots are public: they're re-encoded (removing metadata such as location), stored in Vercel Blob under random names, linked from the request issue, and deleted after 90 days by the daily "Clean up screenshots" workflow, which also removes orphaned uploads after 24 hours. Run it manually from the Actions tab (dry run by default) to preview changes.

To turn the cleanup on: create a GitHub Environment named `screenshot-cleanup` limited to the `main` branch, store `BLOB_READ_WRITE_TOKEN` there (not as a repository secret), and set the repository variable `SCREENSHOT_CLEANUP` to `on`. Optionally set `PORTAL_BOT_LOGIN` to the App's bot login (for example `your-app[bot]`) so only its issues are edited. Submitters must confirm a screenshot can be published. Use a Blob store dedicated to screenshots, because the token can read and write the whole store.

To take a screenshot down immediately:

1. Delete the file from the Blob store (dashboard, or `del(url)` with the store token).
2. Edit the request issue and replace the screenshot link with "removed".
3. Browsers may keep a cached copy for up to an hour.

## Contributing

- When forking, include all branches (GitHub copies only `main` by default) and branch from `develop`. Open pull requests with `develop` as the base branch (GitHub defaults new PRs to `main`, so change the base). `main` only receives releases. Both branches are protected.
- Set up once per clone: `corepack enable pnpm && pnpm install`, then `pre-commit install`. The hooks check formatting (with the project's Prettier) and workflow files, and scan for secrets.
- CI runs lint, typecheck, tests, build, the pre-commit hooks, a secret scan and a content policy check on pull requests into `develop` and `main`.
- Commits in this public repo show the author's name and email. Use a personal address or your GitHub noreply address (`<id>+<username>@users.noreply.github.com`), set it with `git config user.email`.

## License

[MIT](LICENSE)
