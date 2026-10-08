# Roadmap

## v0.1 本地实现

Foundation、Electron shell、provider、conversation、streaming、Agent loop、tools、permissions、SQLite、editable Memory、desktop polish、macOS packaging 与 offline E2E 组成当前实现。最终 local gates/evidence 见 VALIDATION.md；尚未 commit/push 或执行 remote CI。

## v1.0 持续实施

基于现有 v0.2，目标是可靠完成联网研究、文件整理和连续多轮任务。固定验收集、计分与授权边界见 [V1-ACCEPTANCE](V1-ACCEPTANCE.md)。先关闭实际任务缺口，不按版本数量扩展能力。

实施顺序：文件元数据/分页及批量累计资源上限 → 执行与审批预算、长对话上下文 → 有限研究授权与搜索连接测试 → partial/stale/cancel/restart 核对 → 完整任务和构建/打包证据 → 获得授权后验证真实服务。

已实现文件发现、累计计划资源上限、有限执行/审批预算、execution-only context compaction、受控研究授权、搜索连接测试、初始化取消/预算和恢复核对。固定 30 项已有可执行离线任务集及逐项证据，不能计作真实模型完成率。凭据 envelope 持久绑定 endpoint，取消后保留实际 native reservation；本地 ad-hoc 包的首次 native credential availability 等待仍有失败观察。继续关闭验收 oracle 与打包/OS 凭据体验缺口，再进行获授权的真实任务验证。已有 v0.2 验收是历史快照，当前进展见 [V1-VALIDATION](V1-VALIDATION.md)。

真实验证规范见 [V1-REAL-VALIDATION](V1-REAL-VALIDATION.md)。额度预留/保守 receipt、SQLite 跨进程 dispatch 账本、精确快照匹配、provider/Web 计量接缝、纯 report 一致性 validator 及默认拒绝 dry-run 已作为离线准备实现。连接探测、任务/摘要与受控研究通过实际服务入口验证。下一步为完整真实 runner、可信观察/语义审查与 ledger reconciliation、真实端口/native 路径和明确凭据/数据/预算授权。当前 0/30，不能将这些基础模块或打包回归计作真实完成率。

## Dots 已批准路线（本轮仅 M003）

用户批准的目标是受控、可恢复、可观察且持续推进长期目标的 Research Dot。M001 commit 为 `62d1f9c`，M002 commit 为 `50bb182f349fef070b3a47f8c77047c25b066412`。M002 已完成零依赖 `@prospero/dots` 的 identity/goal、独立 Dot/Run lifecycle 与不可变转换。2026-10-08 本轮只实施 M003，已实现并通过离线验证；当前仅达到 **Level 1 — Durable**。

M003 在既有 persistence owner 增加 schema v3 `dots` / `dot_runs`、可信 public rehydration、受约束 repository、revision CAS、原子 pair 与有界历史查询。重开读取实际 pending/running 状态，不执行 Startup Recovery；不增加 events/checkpoint/wake/approval/runtime/UI。迁移保留旧数据，live credential selection 兼容 v3 且仍只复制选中的密文与 provider metadata，不复制 Dots。独立进程重读不等于恢复或自治；精确验证结果见本阶段 Milestone Result，真实任务仍为 `0/30`。

| Milestone | 获批范围 |
| --- | --- |
| M003 Durable Dot/Run Repository | 已实现并通过离线验证；仓储、CAS、原子 pair、旧数据兼容；Level 1 Durable |
| M004 Startup Recovery | exclusive owner 后独立处理遗留 in-flight；不由 read 触发 |
| M005 Shared Execution Admission | Chat/Dot 共用 main-owned 单执行入口 |
| M006 Minimal Durable Progression | 有界已完成/待做事实、工作位置与 checkpoint |
| M007 Bounded Dot Runner | 正式 service 有限 Run；后续 Run 消费前次 checkpoint |
| M008 Opt-in Runtime Suspension | core 最小挂起原语，保持 Chat 默认行为 |
| M009 Durable Approval & Exact Intent Resume | pending/decision/revalidate/consume/dispatch 与 unknown gate |
| M010 Dot-owned Bounded Research | 独立 Dot owner、单次有限研究与真实来源链 |
| M011 Bounded Repeat-research Policy | 可撤销 scope 与跨 Run 累计预算；不授权 write/shell |
| M012 Durable One-shot Wake Intent | UTC dueAt、稳定 wake ID 与原子 claim/取消 |
| M013 Observable Dots UI & Controls | 正常 Prospero UI 创建、管理、审批、查看进展 |
| M014 Restart-aware Scheduler | DB-driven timer、due scan、overdue catch-up |
| M015 Window-independent Dot Lifetime | 分离 Chat/window 与 Dot/app；Quit 停止、无 daemon |
| M016 Research MVP Validation | 正常 UI/service 的完整受控研究、持久进展与唤醒验收 |

具体依赖、验收与风险见 [DOTS_ARCHITECTURE](DOTS_ARCHITECTURE.md)。M007/M013 必须提供可运行垂直切片；M016 才是完整 Research MVP。复杂 planner/task graph、完整 memory/retrieval、event/recurrence、proactive significance/notification、动态 integrations、多场景 showcases 与 Always-on 宿主属于 post-MVP，按真实需求另行规划。

Roadmap 可根据源码与实验结果修订；每次只实施一个获批 milestone。本轮完成 M003 后停止，仅建议 M004 Startup Recovery，不自动实施后续阶段，不 push。

## 其他延期能力

先依据真实使用验证 context compaction、复杂写入体验、provider compatibility 和跨平台 process cleanup。以后才考虑 browser capability、Gmail/Calendar/Drive/GitHub 连接、MCP 和更丰富 global explicit memory；Dots 的本地唤醒与任务 context 按上述新阶段单独验证。

不提前创建 Tempest；只有 Ariel 与 Prospero 形成经实践验证的稳定公共 runtime 边界，再评估提取。自动 memory、cloud sync、账号与多 Agent 不进入 v0.1。
