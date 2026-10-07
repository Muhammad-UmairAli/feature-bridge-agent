# feature-bridge-agent

Submit a feature request, review an AI-generated plan, and get a tested, reviewed preview of the feature.

Setup and usage docs are coming soon.

## Contributing

- Work on a feature branch and open a pull request with `develop` as the base branch (GitHub defaults new PRs to `main`, so change the base). `main` only receives releases. Both branches are protected.
- Set up once per clone: `corepack enable pnpm && pnpm install`, then `pre-commit install`. The hooks check formatting (with the project's Prettier) and workflow files, and scan for secrets.
- The `pnpm` scripts assume a POSIX shell (macOS, Linux, WSL or Git Bash).
- Commits in this public repo show the author's name and email. Use a personal address or your GitHub noreply address (`<id>+<username>@users.noreply.github.com`), set it with `git config user.email`.
