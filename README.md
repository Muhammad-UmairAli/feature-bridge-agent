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

| Name                             | Kind       | Where it's set                                                                  | Purpose                                                                                                                                                      |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GH_APP_ID`                      | Variable   | Vercel (Production)                                                             | _Planned._ GitHub App the portal uses to create and read issues                                                                                              |
| `GH_APP_INSTALLATION_ID`         | Variable   | Vercel (Production)                                                             | _Planned._ That app's installation on the target repository                                                                                                  |
| `GH_APP_PRIVATE_KEY`             | Secret     | Vercel (Production)                                                             | _Planned._ The app's private key (PEM; paste as-is in Vercel)                                                                                                |
| `REQUEST_TARGET_REPO`            | Variable   | Vercel (Production)                                                             | _Planned._ Repository that receives requests (`owner/name`)                                                                                                  |
| `NEXT_PUBLIC_BOT_CHECK_SITE_KEY` | Public key | Vercel                                                                          | Cloudflare Turnstile widget; built into the page, so public by design                                                                                        |
| `BOT_CHECK_SECRET_KEY`           | Secret     | Vercel (Production)                                                             | Server-side Turnstile verification                                                                                                                           |
| `BOT_CHECK_HOSTNAMES`            | Variable   | Vercel (Production)                                                             | Comma-separated hostnames the widget may be served from. Required in production; elsewhere it defaults to the deployment or request host                     |
| `BLOB_READ_WRITE_TOKEN`          | Secret     | Vercel (Production; created when a Blob store is connected) and Actions secrets | _Planned._ Screenshot storage and the 90-day cleanup job; update both copies when rotated                                                                    |
| `DAILY_SUBMISSION_CAP`           | Variable   | Vercel (Production)                                                             | _Planned._ Max accepted submissions per UTC day (default 20)                                                                                                 |
| `LLM_API_KEY`                    | Secret     | Actions secrets                                                                 | _Planned._ Key for the model provider the agents use                                                                                                         |
| `LLM_PROVIDER`, `LLM_MODEL`      | Variables  | Actions variables                                                               | _Planned._ Which provider and model the agents call                                                                                                          |
| `LLM_MAX_TOKENS_PER_REQUEST`     | Variable   | Actions variables                                                               | _Planned._ Per-request token cap for agent runs                                                                                                              |
| `APPROVER_ALLOWLIST`             | Variable   | Actions variables                                                               | _Planned._ GitHub usernames allowed to approve and steer the agents                                                                                          |
| `CONTENT_POLICY_PATTERNS`        | Secret     | Actions secrets                                                                 | Private patterns for the content policy check. Required for pull requests within your own repository; pull requests from forks skip the check with a warning |

## Contributing

- When forking, include all branches (GitHub copies only `main` by default) and branch from `develop`. Open pull requests with `develop` as the base branch (GitHub defaults new PRs to `main`, so change the base). `main` only receives releases. Both branches are protected.
- Set up once per clone: `corepack enable pnpm && pnpm install`, then `pre-commit install`. The hooks check formatting (with the project's Prettier) and workflow files, and scan for secrets.
- CI runs lint, typecheck, tests, build, the pre-commit hooks, a secret scan and a content policy check on pull requests into `develop` and `main`.
- Commits in this public repo show the author's name and email. Use a personal address or your GitHub noreply address (`<id>+<username>@users.noreply.github.com`), set it with `git config user.email`.

## License

[MIT](LICENSE)
