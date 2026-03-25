# Dev Handoff

## 目的

这套 handoff 文档用于解决两个问题：

- 开发现场如何跨电脑、跨终端、跨聊天入口续做
- 开发状态如何和项目状态、代码状态分开记录

## 文档分工

- `docs/handoff/current.md`：当前开发现场、分支、关键文件、校验与风险
- `docs/handoff/next.md`：下一次继续时的第一手入口
- `docs/development-workflow.md`：分支、worktree、hotfix、回滚、开发默认动作

## 默认读取顺序

1. `AGENTS.md`
2. `docs/dev-handoff.md`
3. `docs/handoff/current.md`
4. `docs/handoff/next.md`
5. `README.md`
6. 如有需要，再看代码、配置与脚本

## 使用规则

- 每次结束较大任务前，尽量更新 `docs/handoff/current.md` 和 `docs/handoff/next.md`。
- 如果当前存在未提交实验、临时稳定分支、多个 worktree、待处理风险，必须写进 handoff。
- handoff 只写事实、状态和下一步，不写过程性闲聊。
