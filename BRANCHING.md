# Branching Guide

## Protected branches

- `main`: stable releases only, no direct pushes.
- `codex/team-dev`: shared integration branch for the team.

## Daily flow

1. Update local integration branch.
2. Create your own work branch from `codex/team-dev`.
3. Open a PR back into `codex/team-dev`.
4. Merge `codex/team-dev` into `main` only after review and smoke testing.

## Branch names

- `feat/<area>-<short-desc>` for features
- `fix/<area>-<short-desc>` for bug fixes
- `refactor/<area>-<short-desc>` for code cleanup
- `docs/<area>-<short-desc>` for documentation
- `chore/<area>-<short-desc>` for tooling or maintenance
- `hotfix/<area>-<short-desc>` only for urgent fixes from `main`

Recommended areas for this repo: `ui`, `api`, `db`, `prompt`, `media`, `deploy`.

Examples:

- `feat/ui-shotlist-editor`
- `fix/api-render-timeout`
- `docs/deploy-env-setup`

## PR rules

- Personal branches target `codex/team-dev`.
- `codex/team-dev` targets `main`.
- Keep PRs focused on one feature, fix, or refactor.
- Rebase or merge `codex/team-dev` before requesting review.

## Commit style

- `feat: add shot planning panel`
- `fix: handle empty scene generation`
- `docs: update local run instructions`

## Quick commands

```bash
git checkout codex/team-dev
git pull --ff-only origin codex/team-dev
git checkout -b feat/ui-shotlist-editor
git push -u origin feat/ui-shotlist-editor
```
