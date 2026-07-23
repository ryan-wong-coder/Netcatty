# Cursor CLI automation

GitHub Actions orchestration that uses **Cursor CLI** for issue triage and
implementation of high-confidence bugs / small features. Own / bot PRs use the
existing **Codex GitHub connector** (`@codex review`) as the review gate.

Third-party / fork PRs are **not** reviewed by Cursor CLI. Their initial Codex
review is assumed to be auto-configured on the repo; this workflow only
re-comments `@codex review` after the author pushes more commits
(`pull_request` synchronize).

## Required secret

| Secret | Purpose |
|---|---|
| `CURSOR_API_KEY` | Cursor CLI authentication (issue classify/implement + own PR fix loop) |

Optional:

- `TRIAGE_GITHUB_TOKEN` — optional PAT for PR comments / fork re-`@codex`.
- `SLACK_WEBHOOK_URL` — status pings.

Fork re-`@codex` uses `pull_request_target` (default-branch checkout only) so
`GITHUB_TOKEN` can write comments. Write tokens are step-scoped only (never
workflow-wide). Agent steps run without git credentials; publish uses a fresh
clone.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `CURSOR_CODEX_FIX_MAX_ROUNDS` | `40` | Max Cursor fix ↔ `@codex review` loops on own/bot PRs |
| `CURSOR_TRIAGE_DAILY_LIMIT` | `10` | Daily auto triage for non-collaborators |
| `AUTOMATION_OWN_ACTORS` | `binaricat` | Logins treated as first-party PR authors |

## Manual retry

Actions → **Cursor automation** → Run workflow → provide an issue or PR number.

## Safety

- External / fork PRs: only re-trigger Codex; **no** Cursor CLI review and **no** commits.
- Own / bot PR Codex findings: Cursor CLI may push fixes (max rounds).
- Automation never publishes changes under `.github/` or automation scripts.
- Issue text is sanitized before prompts.
