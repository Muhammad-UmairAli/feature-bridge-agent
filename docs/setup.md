# Run your own copy: setup guide

This guide takes you from a fork of this repository to a working copy: a public request form, a planning agent, an approval step, a coding agent that opens pull requests, an automated review and preview deployments.

It includes the mistakes that are easy to make and how to avoid them. Read [the security model](#9-security-model-and-your-responsibilities) before you open the form to the public: an AI agent writes code from anonymous requests, and you are the last line of defence.

**Time:** about one to two hours. **Cost:** can be zero (hosting hobby plan, a free model); see [Cost, limits and privacy](#7-cost-limits-and-privacy).

> **Never paste a secret into an issue, a commit, a chat, a screenshot or a pull request.** Each secret below goes in exactly one place (two for the Blob token). If one ends up anywhere else, treat it as leaked and [rotate it](#8-rotating-keys-and-responding-to-a-leak).

## 1. What you need

| You need               | For                                                                   |
| ---------------------- | --------------------------------------------------------------------- |
| A GitHub account       | The repository, two GitHub Apps, Actions, environments, rulesets      |
| A Vercel account       | Hosting the portal and preview deployments, and screenshot storage    |
| A Cloudflare account   | The Turnstile bot check on the public form (the free plan is enough)  |
| An OpenRouter account  | The model the agents call (any OpenAI-compatible provider also works) |
| A current GitHub CLI   | `gh` is used throughout; run `gh auth login` once (tested with 2.102) |
| Node.js 24 and pnpm 12 | Only to run the project locally (`corepack enable pnpm`)              |

You must be an **admin** of the repository: several steps change Actions settings, environments and rulesets. Turn on two-factor authentication or passkeys for every account above.

## 2. How the pieces fit

1. A visitor submits the form on your **Vercel** site. The portal creates a GitHub issue as the **portal GitHub App**.
2. The **Plan request** workflow (Actions, with the model key) comments a plan on the issue and adds `plan-ready`.
3. A maintainer on `APPROVER_ALLOWLIST` applies `approved-by-human`.
4. The **Build request** workflow generates a demo with the model, then opens a pull request from `request-<number>` as the **coding agent GitHub App**.
5. CI, the **Write scope** check and the **Review request** workflow run on that pull request, and Vercel publishes a preview.
6. A human reviews and merges. Agents never merge, as long as the rulesets in [4.10](#410-branch-and-tag-rules) are in place and the coding agent App is not a bypass actor.

Two properties shape the setup:

- **Workflows triggered by issues, schedules and `pull_request_target` run from the default branch.** Until the workflows are on `main`, only CI and the content policy (which use `pull_request`) run. Write scope is a `pull_request_target` workflow, so it waits for `main` too.
- **Secrets are split by job.** The model key lives in the `agents` environment, the coding agent key in `agent-app`, the Blob token in `screenshot-cleanup`. Each environment can only be used from `main`. That limits which jobs can read each secret, but anyone who can merge to `main` can reach all three, so `main` must be protected.

## 3. Checklist, in order

The full reference for every setting is the table in the [README's Configuration section](../README.md#configuration). This guide shows where each value comes from and in what order to create it. Decide your Vercel project name (which sets your production hostname) before step 6.

1. [ ] Fork the repository, enable Actions and Issues, set the code owner ([4.1](#41-fork-the-repository))
2. [ ] Labels and Actions settings ([4.2](#42-labels-and-actions-settings))
3. [ ] Portal GitHub App ([4.3](#43-portal-github-app))
4. [ ] Coding agent GitHub App, without its key yet ([4.4](#44-coding-agent-github-app))
5. [ ] Model provider key ([4.5](#45-model-provider))
6. [ ] Turnstile widget ([4.6](#46-bot-check-turnstile))
7. [ ] Vercel project, variables and Blob store ([4.7](#47-vercel))
8. [ ] GitHub environments, variables and secrets ([4.8](#48-github-environments-variables-and-secrets))
9. [ ] Content policy patterns ([4.9](#49-content-policy-patterns))
10. [ ] Rulesets, **before** storing the coding agent key ([4.10](#410-branch-and-tag-rules))
11. [ ] Store the coding agent key ([4.11](#411-store-the-coding-agent-key))
12. [ ] Get the workflows onto `main` ([4.12](#412-get-the-workflows-onto-main))
13. [ ] Require the Write scope check ([4.13](#413-require-the-write-scope-check))
14. [ ] Smoke test ([4.14](#414-smoke-test))

## 4. Step by step

Set a shell variable for the commands below:

```bash
repo="your-account/your-fork"      # replace with your fork, for example octocat/feature-bridge-agent
```

### 4.1 Fork the repository

1. Fork it on GitHub with **Copy the `main` branch only** **unticked**. You need both `main` and `develop`.
2. Keep `main` as the default branch. The environments and workflows depend on it.
3. Open the fork's **Actions** tab and enable workflows. GitHub switches them off on new forks.
4. Settings, General, Features: tick **Issues**. GitHub disables Issues on forks, and the portal creates requests as issues.
5. Settings, General: make sure **Allow auto-merge** is off.
6. Edit `.github/CODEOWNERS`: replace the upstream owner with your own username (or a team with write access). The `main` rule in 4.10 requires a code owner review, and an owner without write access to your fork cannot give one. Commit the change to **both** `main` and `develop` now, while no rulesets exist yet.

Forks do not copy secrets, variables, environments or rulesets. Everything in this guide is configured per fork.

### 4.2 Labels and Actions settings

Create the labels the agents use:

```bash
for label in portal-request planning plan-ready changes-requested approved-by-human needs-human-triage escalated-to-human; do
  gh label create "$label" --repo "$repo"
done
```

Tighten the Actions settings (Settings, Actions, General, or the commands below):

```bash
# Default token permissions: read-only. Actions may not create or approve pull requests.
gh api -X PUT repos/$repo/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Pull request workflows from outside contributors need your approval first.
gh api -X PUT repos/$repo/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
```

Optional: shorten log retention (Settings, Actions, General), because generated files appear in build logs. Also consider restricting which actions may run (Settings, Actions, General, Actions permissions).

### 4.3 Portal GitHub App

The portal creates and reads request issues as a GitHub App, so no personal token is involved.

1. GitHub, your avatar, Settings, Developer settings, GitHub Apps, **New GitHub App**.
2. **Name:** something unique, for example `<you>-request-portal`. The name in the App's URL (`github.com/apps/<slug>`) is its **slug**.
3. **Homepage URL:** your Vercel site URL (you can change it later).
4. **Webhook:** untick **Active**.
5. **Repository permissions**, and nothing else:
   - Issues: **Read and write**
   - Pull requests: **Read-only**
   - Deployments: **Read-only**
   - Metadata: **Read-only** (set automatically)
6. **Where can this App be installed:** Only on this account. Create it.
7. On the App's General page, note the **App ID**. Generate a **private key**: a `.pem` file downloads. It goes straight into Vercel (step 4.7). Then delete the file, including from a cloud-synced Downloads folder, and empty the Trash.
8. Install App, **Only select repositories**, choose your fork.
9. After installing, the browser URL ends with the **installation ID**: `github.com/settings/installations/<number>`.

Values you now have: `GH_APP_ID`, `GH_APP_INSTALLATION_ID`, the private key, and `PORTAL_BOT_LOGIN` = `<slug>[bot]`.

### 4.4 Coding agent GitHub App

A second App commits demos and opens pull requests, so CI and previews run on them. It is separate from the portal App on purpose.

1. Create another GitHub App: webhook off, only on this account.
2. **Homepage URL:** the repository URL (the field is required but nothing reads it).
3. **Repository permissions**, and nothing else:
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Metadata: **Read-only**

   Do **not** grant Workflows or Issues, or any organization or account permission. The agent refuses to run if its installation holds anything else.

4. Install it with **Only select repositories**, choosing your fork.
5. Note the **App ID** and the slug. `AGENT_APP_LOGIN` = `<slug>[bot]`.
6. **Do not generate its private key yet.** The key can write to your repository, so the rules in [4.10](#410-branch-and-tag-rules) come first.

### 4.5 Model provider

The agents call any OpenAI-compatible chat endpoint over HTTPS. The key is sent to whatever `LLM_BASE_URL` points to, so use a provider you trust. These steps use OpenRouter.

1. Create an account and, if you will use paid models, add a small amount of credit.
2. Create an API key **just for this project** and set a **credit limit** on it (for example $5 to $10). The limit means a mistake, such as a paid model id, fails instead of spending.
3. Choose a model id from the provider's model list; it looks like `provider/model-name`.
   - Builds ask for up to 12,000 output tokens, so pick a model with a large context window and long replies.
   - Prefer models that answer directly. A model that spends many tokens on hidden reasoning can be cut off mid-answer, and the run then fails.
   - Screenshots are sent to the model only if you set `LLM_IMAGE_INPUT` to `on` (off by default), and only image-capable models accept them. With a text-only model, leave it unset.
4. Check the provider's privacy settings. Prompts contain the public request text, `AGENTS.md`, the file list, plans, generated code and maintainers' review comments.
5. The key goes into the GitHub `agents` environment later ([4.8](#48-github-environments-variables-and-secrets)). Never paste it anywhere else.

Free models: OpenRouter lists models whose id ends in `:free` ([free models](https://openrouter.ai/collections/free-models), [limits](https://openrouter.ai/docs/api-reference/limits)). The free list changes without notice, so check the live page: a model that works today can disappear. One example seen in October 2026 was `poolside/laguna-s-2.1:free`. Free models are rate limited, and their providers may use prompts for training. That is acceptable here because everything in the prompts is already public, but check the provider's privacy settings anyway.

Values you now have: the API key, `LLM_BASE_URL` (`https://openrouter.ai/api/v1`) and `LLM_MODEL`.

### 4.6 Bot check (Turnstile)

1. Cloudflare dashboard, Application security, **Turnstile** (or use the search box), **Add widget**.
2. **Name:** anything. **Hostname:** your production hostname, for example `<project>.vercel.app`, with no `https://` and no path. Add a custom domain here too if you use one. If Vercel gives your project a different name than you expected, edit the widget's hostnames afterwards.
3. **Widget mode:** Managed. Create it.
4. Copy the **Site Key** (public by design) and the **Secret Key**.

For local development, Cloudflare publishes always-pass test keys; see the comments in `.env.example`.

### 4.7 Vercel

1. Vercel, **Add New, Project**, import your fork. Production branch: `main`. Install the Vercel GitHub app on this repository only.
2. In the project's Build and Development Settings, make sure **Framework Preset is Next.js** and that **Build Command, Output Directory and Install Command have no overrides**. If the project was imported while `main` had no app, Vercel may have saved a generic preset with an output directory of `dist`, and builds then fail at the end with `No Output Directory named "dist" found`.
3. **Storage, Create, Blob.** Choose **Public** access (the planner only reads screenshots from `https://<store>.public.blob.vercel-storage.com/screenshots/...`). Connect it to **Production only**.
4. Settings, Environment Variables. Add the variables below. Vercel ticks every environment by default: **untick Preview and Development** for everything marked Production.

   | Name                             | Value                                                | Environments                  |
   | -------------------------------- | ---------------------------------------------------- | ----------------------------- |
   | `GH_APP_ID`                      | portal App ID                                        | Production                    |
   | `GH_APP_INSTALLATION_ID`         | installation ID                                      | Production                    |
   | `GH_APP_PRIVATE_KEY`             | the whole `.pem` file, including BEGIN and END lines | Production                    |
   | `REQUEST_TARGET_REPO`            | `<owner>/<repo>`                                     | Production                    |
   | `NEXT_PUBLIC_BOT_CHECK_SITE_KEY` | Turnstile Site Key                                   | Production (all is also fine) |
   | `BOT_CHECK_SECRET_KEY`           | Turnstile Secret Key                                 | Production                    |
   | `BOT_CHECK_HOSTNAMES`            | your production hostname(s), comma separated         | Production                    |
   | `BLOB_READ_WRITE_TOKEN`          | created when the store is connected (see below)      | Production                    |

   Mark the private key and the Turnstile secret **Sensitive**. Optional: `DAILY_SUBMISSION_CAP` (default 20) and `PREVIEW_HOST_SUFFIXES` (default `.vercel.app`; you can narrow it to your team's preview hosts, for example `-<team-slug>.vercel.app`, so only those hosts are trusted as preview links).

5. **Check the list after saving.** Each secret must appear in exactly one row, for Production. If a secret shows a Preview or Development row, remove it: preview builds run pull request code, including code the agent wrote, and must not see secrets. If a row created by the store connection cannot be edited or removed on the variables page, change which environments the store is connected to in the store's settings, or disconnect it and reconnect it for Production only.
6. If `BLOB_READ_WRITE_TOKEN` is not in the list after connecting the store, open the store page, the **.env.local** tab, copy the token from there and add it yourself (Production only). You need this value again in 4.8, so copy it from the same tab then.
7. Delete any downloaded `.pem` file (and empty the Trash). Redeploy production so the variables load.

Notes:

- **Hobby plan:** Vercel's free plan is for personal, non-commercial use.
- **Preview protection:** previews are normally behind Vercel sign-in. Keep it on and verify it is on (Settings, Deployment Protection): the default depends on your plan and when the project was created. Preview pages run unreviewed agent-written code, and the preview link on the request tracking page will ask visitors to log in. Open previews only after you have reviewed the diff, and accept that anyone who can reach a preview can run that code in their browser.
- **Agent commits:** some hosting plans restrict which commit authors can trigger deployments. Check in the smoke test that the preview deploys for the coding agent's commit.
- A GitHub integration may create `Preview` and `Production` environments in your repository. Leave them alone.

### 4.8 GitHub environments, variables and secrets

**Variables vs secrets matters.** The workflows read these settings through `vars.*`, which cannot see secrets. A setting saved in the wrong place looks present but is missing to the workflow.

**Repository variables** (Settings, Secrets and variables, Actions, **Variables** tab):

```bash
gh variable set PORTAL_BOT_LOGIN    --repo $repo --body '<portal-slug>[bot]'
gh variable set AGENT_APP_LOGIN     --repo $repo --body '<coder-slug>[bot]'
gh variable set APPROVER_ALLOWLIST  --repo $repo --body '<your-github-username>'
gh variable set LLM_BASE_URL        --repo $repo --body 'https://openrouter.ai/api/v1'
gh variable set LLM_MODEL           --repo $repo --body '<model-id>'
# Optional: LLM_MAX_TOKENS_PER_REQUEST (default 50000); LLM_IMAGE_INPUT=on only for image-capable models.
# Set SCREENSHOT_CLEANUP=on only after the Blob token is in its environment (below).
```

`AGENT_APP_LOGIN` switches on the review, revision and CI breaker workflows. That is harmless until requests exist, but until the coding agent key is stored (4.11) a build's publish step reports missing settings.

`APPROVER_ALLOWLIST` lists the GitHub usernames whose approvals the agents accept (comma or space separated). They also need triage access or higher. Empty means nobody can approve. Keep it to people, never a bot login, with two-factor authentication on, and remove people who leave: a released or renamed username can be claimed by someone else.

**Environments.** Create three, each limited to `main` with no required reviewers:

```bash
for env in agents agent-app screenshot-cleanup; do
  echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
    | gh api -X PUT repos/$repo/environments/$env --input -
  echo '{"name":"main","type":"branch"}' \
    | gh api -X POST repos/$repo/environments/$env/deployment-branch-policies --input -
done

gh variable set AGENT_APP_ID --env agent-app --repo $repo --body '<coder-app-id>'
```

**Secrets.** `gh secret set` asks for the value with hidden input, so it never lands in your shell history. For the Blob token, copy the value from the store page's `.env.local` tab (4.7) when prompted:

```bash
gh secret set LLM_API_KEY             --env agents             --repo $repo
gh secret set BLOB_READ_WRITE_TOKEN   --env screenshot-cleanup --repo $repo
# AGENT_APP_PRIVATE_KEY is stored later (4.11).
```

Then, once the Blob token is there: `gh variable set SCREENSHOT_CLEANUP --repo $repo --body on`.

Never create `PORTAL_BOT_LOGIN`, `APPROVER_ALLOWLIST` or `LLM_*` variables inside an environment: environment values override repository ones, so different jobs could check different lists. Make sure `LLM_API_KEY`, `AGENT_APP_PRIVATE_KEY` and `BLOB_READ_WRITE_TOKEN` do **not** also exist as repository- or organization-level secrets.

### 4.9 Content policy patterns

CI fails any pull request whose content matches a private pattern list. The `Content policy` check is required, so **the list must contain at least one usable pattern**, or every pull request fails with `CONTENT_POLICY_PATTERNS is not configured` or `contains no usable patterns`.

- **Name:** `CONTENT_POLICY_PATTERNS`, a repository secret. One extended regular expression per line (plain words work), case-insensitive. Lines starting with `#` are ignored.
- List names that must never appear in your public repository, such as company, client and internal tool names. If you have none, use a placeholder that will never match, such as `zz-never-matches-zz`.
- **What it scans:** every tracked file (`git grep`), commit messages and author names and emails, the pull request title and description, and the branch name. A pattern that matches your own username or email will fail every pull request.
- Pull requests from forks skip the check with a warning, so review the text of outside pull requests yourself.
- The patterns do not appear in the shipped workflow's logs, but the list is only as private as your write-access list: anyone who can change workflows on a branch that runs the check could print it.

Create the file **outside the repository**, load it, and remove it. It lists exactly the names you do not want published, so never `git add` it:

```bash
patterns=$(mktemp)                # a file outside your clone
$EDITOR "$patterns"               # one pattern per line
gh secret set CONTENT_POLICY_PATTERNS --repo $repo < "$patterns"
rm "$patterns"
```

### 4.10 Branch and tag rules

Do this **before** storing the coding agent key. The App can write contents, so the rules are what keep it inside its lane. Complete 4.1 step 6 (the code owner) first.

Required checks, from the CI and content policy workflows: `Lint, typecheck, test, build`, `Pre-commit hooks`, `Secret scan (git history)` and `Content policy`. They are reported by the GitHub Actions app (id `15368`); pinning that id stops another app from faking a passing check.

**Also require `Write scope` now** (add `{ "context": "Write scope", "integration_id": 15368 }` to the checks in both rulesets) **if `.github/workflows/write-scope.yml` is already on `main`**, which is the normal case for a fork. It is what stops an agent pull request from touching files outside its demo folder. If `main` does not have that workflow yet, do not approve any request until you have completed [4.13](#413-require-the-write-scope-check). Requiring a check that never reports blocks every merge, so add it only when its workflow is on the default branch.

The JSON below is the source of truth for these rulesets.

<details>
<summary><code>main</code> ruleset</summary>

```json
{
  "name": "main protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Lint, typecheck, test, build", "integration_id": 15368 },
          { "context": "Pre-commit hooks", "integration_id": 15368 },
          { "context": "Secret scan (git history)", "integration_id": 15368 },
          { "context": "Content policy", "integration_id": 15368 }
        ]
      }
    },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

</details>

<details>
<summary><code>develop</code> ruleset</summary>

```json
{
  "name": "develop protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/develop"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Lint, typecheck, test, build", "integration_id": 15368 },
          { "context": "Pre-commit hooks", "integration_id": 15368 },
          { "context": "Secret scan (git history)", "integration_id": 15368 },
          { "context": "Content policy", "integration_id": 15368 }
        ]
      }
    },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

</details>

<details>
<summary>Rulesets that keep the coding agent inside <code>request-*</code> branches, and tag rules</summary>

```json
{
  "name": "request branches: no force push or delete",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/request-*"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }]
}
```

```json
{
  "name": "other branches: maintainer only",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~ALL"],
      "exclude": ["refs/heads/request-*", "refs/heads/main", "refs/heads/develop"]
    }
  },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [
    { "type": "creation" },
    { "type": "update", "parameters": { "update_allows_fetch_and_merge": false } },
    { "type": "deletion" }
  ]
}
```

```json
{
  "name": "tags: maintainer only",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [
    { "type": "creation" },
    { "type": "update", "parameters": { "update_allows_fetch_and_merge": false } },
    { "type": "deletion" }
  ]
}
```

</details>

Save each block to its own file and create the rulesets:

```bash
gh api -X POST repos/$repo/rulesets --input main.json
gh api -X POST repos/$repo/rulesets --input develop.json
gh api -X POST repos/$repo/rulesets --input request-branches.json
gh api -X POST repos/$repo/rulesets --input other-branches.json
gh api -X POST repos/$repo/rulesets --input tags.json
```

What these do, and the choices behind them:

- **`actor_id: 5` is the repository Admin role.** On an organization-owned repository, choose the actor that fits your team.
- **Pull requests into `main` need one approval and a code owner review (`CODEOWNERS`).** Agent pull requests are authored by the App, so you can approve them. A **sole maintainer cannot approve their own pull request**, so the admin bypass (pull-request mode) exists for your own release pull requests. Use it deliberately, check that all required checks pass before you do, and drop it if you have a second maintainer. Anyone who can use the bypass can also change `.github/` and `agents/`, which control every secret.
- **The "restrict updates" rule is not applied to `main` or `develop`**, because it can block pull request merges. Those branches have their own rulesets.
- **"Other branches" also blocks creating, updating and deleting any branch outside `request-*`, `main` and `develop`.** That keeps the coding agent inside `request-*` and stops it deleting your branches. Bots that open branches (such as a dependency updater) need an exception.
- **`strict_required_status_checks_policy` is off**, so a pull request does not have to be up to date with its base to merge. Turn it on if you prefer fewer surprises over fewer re-runs.
- **Do not require the hosting provider's check.** Previews can fail for reasons unrelated to a pull request.
- Never add the coding agent App as a bypass actor.

### 4.11 Store the coding agent key

1. Open the coding agent App's page and confirm its permissions are exactly the ones in [4.4](#44-coding-agent-github-app).
2. Generate a private key. A `.pem` file downloads.
3. Store it without typing or pasting it anywhere else, then delete the file (also from a synced Downloads folder, and empty the Trash):

   ```bash
   gh secret set AGENT_APP_PRIVATE_KEY --env agent-app --repo $repo < path/to/key.pem
   rm path/to/key.pem
   ```

4. Until `Write scope` is a required check (4.10 or 4.13), do not approve any request.

### 4.12 Get the workflows onto `main`

The agent workflows (planning, build, review, revisions, CI breaker, metrics, cleanup, write scope) only run once they are on the **default branch**.

- **Normal case for a fork:** `main` already contains `.github/workflows`. Nothing to do.
- **If `main` is behind `develop`:** open a pull request from `develop` into `main` and merge it with a merge commit. As the author you cannot approve it, so use **Merge without waiting for requirements to be met (bypass rules)**. Check that the required checks pass first.

Merging into `main` also deploys the portal to production, and switches every agent workflow on. Merging does not trigger the workflows by themselves: they wait for events (a new request, a label, a schedule).

### 4.13 Require the Write scope check

Skip this step if you already required `Write scope` in 4.10. Otherwise, after the workflows are on `main`, open any pull request (a small documentation change will do) and wait until **Write scope** reports. It passes on ordinary branches and only restricts `request-*` pull requests. Then add it to both rulesets:

```bash
for name in main develop; do
  id=$(gh api repos/$repo/rulesets --jq ".[] | select(.name==\"$name protection\") | .id")
  gh api repos/$repo/rulesets/$id \
    | jq '{name,target,enforcement,conditions,bypass_actors,
           rules: (.rules | map(if .type=="required_status_checks"
             then .parameters.required_status_checks += [{"context":"Write scope","integration_id":15368}]
             else . end))}' \
    | gh api -X PUT repos/$repo/rulesets/$id --input -
done
```

### 4.14 Smoke test

1. Open your site and submit a short request, for example "A counter with + and - buttons".
2. An issue labelled `portal-request` appears, authored by the portal App.
3. Within a few minutes, the planning agent comments a plan and adds `plan-ready`. (No plan after about ten minutes: see [Troubleshooting](#6-troubleshooting).)
4. **Read the plan, then apply `approved-by-human`.** The build runs and a pull request from `request-<number>` opens. CI, Write scope and the automated review run on it, and the hosting provider publishes a preview.
5. **Read the whole diff before you open the preview.** Approving a plan is not a code review ([section 9](#9-security-model-and-your-responsibilities)).
6. Optional: leave an inline comment on the pull request and apply `changes-requested` to it. One revision is pushed.
7. Merge the pull request yourself (or close it). Check the provider's spend after the first run.

If a step stops, the request gets `needs-human-triage` or `escalated-to-human`, and the Actions run names any missing setting by name, never its value.

## 5. Verify the setup

These commands are read-only and print names, not secret values:

```bash
gh variable list --repo $repo --json name,value --jq '.[] | "\(.name) = \(.value)"'
gh secret list   --repo $repo --json name --jq '.[].name'          # only CONTENT_POLICY_PATTERNS
for env in agents agent-app screenshot-cleanup; do
  echo "== $env"
  gh secret   list --env $env --repo $repo --json name --jq '.[].name'
  gh variable list --env $env --repo $repo --json name,value --jq '.[] | "\(.name) = \(.value)"'
  gh api repos/$repo/environments/$env/deployment-branch-policies --jq '.branch_policies[].name'   # main
done
gh api repos/$repo/rulesets --jq '.[] | "\(.name) | \(.target) | \(.enforcement)"'
gh api repos/$repo/actions/permissions/workflow
gh api repos/$repo/actions/permissions/fork-pr-contributor-approval
```

Expected shape:

| Place                    | Should contain                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository variables     | `PORTAL_BOT_LOGIN`, `AGENT_APP_LOGIN`, `APPROVER_ALLOWLIST`, `LLM_BASE_URL`, `LLM_MODEL`, optionally the others, `SCREENSHOT_CLEANUP`                                                 |
| Repository secrets       | `CONTENT_POLICY_PATTERNS` only                                                                                                                                                        |
| `agents` environment     | secret `LLM_API_KEY`                                                                                                                                                                  |
| `agent-app` environment  | variable `AGENT_APP_ID`, secret `AGENT_APP_PRIVATE_KEY`                                                                                                                               |
| `screenshot-cleanup` env | secret `BLOB_READ_WRITE_TOKEN`                                                                                                                                                        |
| Vercel, Production only  | `GH_APP_ID`, `GH_APP_INSTALLATION_ID`, `GH_APP_PRIVATE_KEY`, `REQUEST_TARGET_REPO`, `BOT_CHECK_SECRET_KEY`, `BOT_CHECK_HOSTNAMES`, `BLOB_READ_WRITE_TOKEN` (plus the public site key) |

## 6. Troubleshooting

| Symptom                                                         | Likely cause and fix                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run fails with `Missing: NAME (where it goes)`                | That setting is not set where the message says. Fix it there; the message never shows values.                                                                                         |
| Settings exist but workflows act as if they are missing         | They were saved as **secrets** and should be **variables** (`gh variable list` vs `gh secret list`). Recreate them as variables and delete the secrets.                               |
| The form fails when you submit                                  | Issues are disabled on your fork (4.1 step 4), or a Vercel Production variable is wrong or missing (App ID, installation ID, key, repository name, bot check keys, hostnames).        |
| A request issue appears but there is no plan                    | Check that `PORTAL_BOT_LOGIN` is a repository variable matching the portal App's `<slug>[bot]`, that `LLM_API_KEY` is in the `agents` environment, and read the Plan request run log. |
| Every pull request fails the `Content policy` check             | `CONTENT_POLICY_PATTERNS` is missing, empty or all comments, or one of your patterns matches your own username, email or the repository text (see 4.9).                               |
| Vercel build ends with `No Output Directory named "dist" found` | An Output Directory override is set. Set the framework preset to Next.js and remove build overrides (see 4.7).                                                                        |
| Vercel install step fails with a pnpm or lockfile error         | Try adding the variable `ENABLE_EXPERIMENTAL_COREPACK=1` (all environments) so Vercel uses the pnpm version pinned in `package.json`.                                                 |
| A Vercel secret appears in Preview or Development               | Remove those rows (or change the store's connected environments). Keep Production only. Rotate the secret if a preview deployed after it was added.                                   |
| No `BLOB_READ_WRITE_TOKEN` after connecting the store           | Copy it from the store page's `.env.local` tab and add it yourself, Production only.                                                                                                  |
| The preview does not deploy for the agent's commit              | Some hosting plans restrict which commit authors can deploy. Check the project's Git settings and the plan's rules for commits by a bot.                                              |
| Preview links ask visitors to sign in                           | Vercel Deployment Protection is on for previews. That is the safer default (see 4.7).                                                                                                 |
| Merging is blocked on a required check that never runs          | The check's workflow is not on the default branch yet, or it is skipped for that pull request. Remove it from the required list until it reports, then add it back.                   |
| Agent pull requests wait for a code owner who cannot approve    | `.github/CODEOWNERS` still names the upstream owner. Replace it with your username or a team with write access (4.1 step 6).                                                          |
| You cannot approve your own pull request                        | Expected: the author cannot approve. Use the admin bypass for your own release pull requests, or add a second maintainer.                                                             |
| Model calls fail with 429 or the model disappears               | Free models are rate limited (daily and per-minute) and the free list changes. Switch `LLM_MODEL` (one variable); purchasing a small amount of credit raises the daily limit.         |
| The daily cleanup workflow fails                                | `SCREENSHOT_CLEANUP` is `on` but `BLOB_READ_WRITE_TOKEN` is missing from the `screenshot-cleanup` environment. Add it, or remove the variable.                                        |
| The build refuses an approval                                   | The approver is not on `APPROVER_ALLOWLIST`, lacks triage access, or the plan changed after it was posted. Read the comment the workflow leaves on the issue.                         |
| A secret was pasted into a chat, issue or log                   | Rotate it now (section 8).                                                                                                                                                            |

## 7. Cost, limits and privacy

- **Model cost.** Anyone can submit a request, and each one costs a planning run. The daily worst case for first plans is `DAILY_SUBMISSION_CAP × LLM_MAX_TOKENS_PER_REQUEST` tokens (20 × 50,000 with the defaults), plus builds, reviews and one revision per request. A credit limit on the provider key caps the damage. Set a spend alert at the provider too.
- **Free models.** At the time of writing, OpenRouter's free models were limited to 20 requests a minute and a daily cap (50 a day before you have bought credit, 1,000 after a one-time purchase of at least $10); check the [limits page](https://openrouter.ai/docs/api-reference/limits) for current figures. One feature costs roughly four to eight model calls. Free providers may log or train on prompts.
- **What the provider sees.** The request text, `AGENTS.md`, the list of files under `src/`, plans, generated demos and maintainers' review comments, and screenshots only if you enable image input.
- **Everything is public.** Requests, plans, comments, pull requests and screenshots are public. Submitters are warned on the form. Screenshots are re-encoded on the server (metadata such as location is removed) and stored under random names. They are deleted after 90 days **only if** `SCREENSHOT_CLEANUP` is `on`, the Blob token is in the `screenshot-cleanup` environment and the scheduled workflow is still running. GitHub switches off scheduled workflows in a public repository after 60 days without repository activity, so check the Actions tab now and then.
- **Vercel Hobby** is for personal, non-commercial use. A commercial deployment needs a team plan.
- **The daily submission cap is a cost limit, not a protection.** It counts all accepted submissions, so anyone can use it up and block real visitors for the rest of the day. The bot check and the model key's credit limit are the other brakes.

## 8. Rotating keys and responding to a leak

| Secret                   | How to rotate                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal App private key   | Generate a new key on the App page, update `GH_APP_PRIVATE_KEY` in Vercel (Production), redeploy, then delete the old key.                                                                                                                                                 |
| Coding agent private key | Generate a new key, update `AGENT_APP_PRIVATE_KEY` in the `agent-app` environment, then delete the old key. If it may have leaked, delete it first, suspend the installation (which ends its tokens) and review the audit log for branch, tag, release and merge activity. |
| Model provider key       | Create a new key, update `LLM_API_KEY` in the `agents` environment, delete the old key, and keep the credit limit. After a leak, also check the provider's usage history.                                                                                                  |
| Turnstile secret         | Rotate it in Cloudflare and update `BOT_CHECK_SECRET_KEY` in Vercel.                                                                                                                                                                                                       |
| Blob token               | Rotate it in Vercel and update **both** Vercel and the `screenshot-cleanup` environment.                                                                                                                                                                                   |

Rotate every key on a schedule you can keep (for example once or twice a year), and always after a suspected leak.

If a secret reached a chat, an issue, a commit, a log or a screenshot, assume it is public: revoke it first, then replace it, then clean up where it appeared. Deleting the message does not make a leaked secret safe, and `rm` does not securely erase a key file: also empty the Trash and any synced copy.

To take a screenshot down immediately: delete the file from the Blob store, edit the request issue and replace the link with "removed". Browsers may keep a cached copy for up to an hour.

## 9. Security model and your responsibilities

This system turns text from anonymous people into code in your repository, through a language model. The controls above reduce the risk. They do not replace you.

- **Approving a plan is not reviewing code.** `approved-by-human` approves a plan. The code that follows can differ from the plan, and a request can try to steer the model (prompt injection). Read the whole diff, not just the plan.
- **Open previews only after you have read the diff.** A preview runs the generated code in the visitor's browser, and merging to `main` publishes it on your production domain. A bad request can aim for a phishing page, a hidden script or abusive content under your name.
- **Agent-written code runs in CI** with network access, without secrets. Do not add secrets, deploy keys or self-hosted runners to the repository, and do not let CI hold more than the standard token.
- **Agents never merge** only while the rulesets hold and the coding agent App is not a bypass actor. Check them after any settings change.
- **Protect your own account.** The admin bypass makes your account the single point of failure. Use two-factor authentication or passkeys on GitHub, Vercel, Cloudflare and the model provider.
- **Turn on GitHub's platform protections** (free for public repositories): secret scanning with push protection, and private vulnerability reporting. Add a `SECURITY.md` that says how to report a problem. The CI secret scan is a second line, not a replacement.
- **Know your kill switches** for an incident, quickest first: empty `APPROVER_ALLOWLIST`; unset `PORTAL_BOT_LOGIN` and `AGENT_APP_LOGIN`; disable the workflows in the Actions tab; revoke the model key; delete or suspend the coding agent installation; pause the Vercel project.
- **Watch it.** Set a spend alert at the model provider, and know where to look: the GitHub audit log, the Actions tab and Vercel's logs.
- **This stack suits a public demo repository.** Do not use it for client or proprietary code: everything in prompts, plans and generated code is public, and the model provider sees it.
