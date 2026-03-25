# AGENTS.md

## 通用协作规范

### 1. 交接优先于 session

- 续做任务时，优先读取仓库内 handoff 和状态文档，不依赖聊天窗口或 runtime session 的隐式记忆。
- Codex / Claude / 其他 runtime 的 thread 或 session 只隔离上下文，不等于已经隔离 Git 分支或工作目录。
- 跨电脑、跨终端、跨入口继续工作时，默认先看文档，再决定是否恢复 runtime session。

### 2. 稳定线、分支与 worktree

- 本仓库默认稳定线是 `main`，当前共享集成线是 `codex/team-dev`。
- 中等及以上任务默认新开分支，不直接在当前分支混做。
- `worktree` 只用于三类场景：并行开发、hotfix、保留稳定现场同时继续开发。
- 如果当前稳定版本暂时不在 `main`，必须在 handoff 文档里写明，不能靠口头默认。

### 3. 事故处理顺序

- 出现异常时，先判断是运行问题、配置问题还是代码回归，再决定是否回滚版本。
- 如果最近改动边界清晰且存在“最后已知可用版本”，优先回到该基线。
- 如果上游数据可重拉、可重跑、可补账，优先恢复数据，不默认手工重做。

## 固定读取顺序

每次新开 Codex、切换电脑、或者重新进入本仓库时，默认按这个顺序读取：

1. `AGENTS.md`
2. `docs/dev-handoff.md`
3. `docs/handoff/current.md`
4. `docs/handoff/next.md`
5. `README.md`
6. 如有需要，再看对应代码、配置和脚本

## 本仓库附加规则

- 详细开发规则统一参考 `docs/development-workflow.md`。
- 中等及以上任务开始前，默认先给出四项声明：当前任务主题或工作线、Git 动作、是否需要 worktree、影响范围。
- 每次较大任务结束前，尽量更新 `docs/handoff/current.md` 和 `docs/handoff/next.md`。
