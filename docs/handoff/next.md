# Next Steps

## 下一步

1. 下次继续本仓库任务时，先按固定读取顺序进入上下文。
2. 中等及以上任务开始前，先看 `docs/development-workflow.md`，判断是否需要从 `codex/team-dev` 同步后新开分支，是否需要 worktree。
3. 较大任务结束前，继续维护 `docs/handoff/current.md` 和 `docs/handoff/next.md`。

## 建议先看

- `AGENTS.md`
- `docs/dev-handoff.md`
- `docs/handoff/current.md`
- `docs/development-workflow.md`
- `README.md`

## 建议先执行的命令

- `git status`
- `git branch --show-current`
- `git log --oneline --decorate -n 5`

## 不要误动的区域

- 不要跳过 handoff 直接只看聊天上下文就开始续做。
- 不要把 runtime session 误以为已经等价于新的 Git 分支或 worktree。
- 不要直接在 `main` 上堆叠中等及以上任务改动。

## 待确认问题

- 后续如果本仓库有更明确的发布、测试或环境约束，再补充到 `docs/development-workflow.md`。
