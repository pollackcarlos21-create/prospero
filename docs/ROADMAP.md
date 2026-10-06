# Roadmap

## v0.1 本地实现

Foundation、Electron shell、provider、conversation、streaming、Agent loop、tools、permissions、SQLite、editable Memory、desktop polish、macOS packaging 与 offline E2E 组成当前实现。最终 local gates/evidence 见 VALIDATION.md；尚未 commit/push 或执行 remote CI。

## v1.0 持续实施

基于现有 v0.2，目标是可靠完成联网研究、文件整理和连续多轮任务。固定验收集、计分与授权边界见 [V1-ACCEPTANCE](V1-ACCEPTANCE.md)。先关闭实际任务缺口，不按版本数量扩展能力。

实施顺序：文件元数据/分页及批量累计资源上限 → 执行与审批预算、长对话上下文 → 有限研究授权与搜索连接测试 → partial/stale/cancel/restart 核对 → 完整任务和构建/打包证据 → 获得授权后验证真实服务。

已实现文件发现、累计计划资源上限、有限执行/审批预算、execution-only context compaction、受控研究授权、搜索连接测试、初始化取消/预算和恢复核对。固定 30 项已有可执行离线任务集及逐项证据，不能计作真实模型完成率。凭据 envelope 持久绑定 endpoint，取消后保留实际 native reservation；本地 ad-hoc 包的首次 native credential availability 等待仍有失败观察。继续关闭验收 oracle 与打包/OS 凭据体验缺口，再进行获授权的真实任务验证。已有 v0.2 验收是历史快照，当前进展见 [V1-VALIDATION](V1-VALIDATION.md)。

真实验证规范见 [V1-REAL-VALIDATION](V1-REAL-VALIDATION.md)。额度预留/保守 receipt、SQLite 跨进程 dispatch 账本、精确快照匹配、provider/Web 计量接缝、纯 report 一致性 validator 及默认拒绝 dry-run 已作为离线准备实现。连接探测、任务/摘要与受控研究通过实际服务入口验证。下一步为完整真实 runner、可信观察/语义审查与 ledger reconciliation、真实端口/native 路径和明确凭据/数据/预算授权。当前 0/30，不能将这些基础模块或打包回归计作真实完成率。

## 延期

先依据真实使用验证 context compaction、复杂写入体验、provider compatibility 和跨平台 process cleanup。以后才考虑 browser capability、background scheduled tasks、Gmail/Calendar/Drive/GitHub 连接、MCP 和更丰富 explicit memory。

不提前创建 Tempest；只有 Ariel 与 Prospero 形成经实践验证的稳定公共 runtime 边界，再评估提取。自动 memory、cloud sync、账号与多 Agent 不进入 v0.1。
