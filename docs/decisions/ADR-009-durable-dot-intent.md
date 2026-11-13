# ADR-009: Durable Dot approval and dispatch intent

状态：仓储、runner、正式 Web composition 和正常审批 UI 已接入。Unknown 人工解除门与更完整的监督/历史仍待实现。日期：2026-10-19。依赖 [ADR-008](ADR-008-runtime-suspension.md)。

## 绑定与状态

SQLite schema v5 增加 Dot-owned `dot_intents` 与 append-only `dot_intent_events`。一个 intent 绑定 Dot/Run、准确 Dot revision、provider ID/endpoint/model、policy revision、core continuation、确切 call/permission key/host preview、createdAt/expiry；SHA-256 digest 覆盖这些 immutable JSON 数据。它不是 conversation 的 ResearchPlan，也不保存密钥、resolver、PreparedTool 或活跃 grant。

首个切片只接 web preview（query 或 URL、固定网络 effects），不泛化 file/shell 的 preview 或恢复。后续 research scope 使用独立明确 owner，不能借 Dot ID 绕过 conversation FK。

状态为 pending → approved → dispatching → succeeded/unknown，或 pending/approved → denied/expired/stale/cancelled。每次状态转换需要 intent revision、完整 digest 和 Run 当前 revision，并在同一事务追加 audit。Approve 仅记录决定，不消费或执行；dispatch 是独立原子 claim，只有重新取得 admission、重新 prepare、检查准确 preview/provider/policy、当前有效期后才能调用。

## 崩溃与控制

未派发的 pending/approved 保留相同 continuation，启动不自动执行。到期或时间异常失去批准；不恢复旧 Promise。dispatching 在启动变为 unknown，Run interrupted，保留原账本。unknown 不等于动作未发生，阻止该 Dot 新 Run，不自动重试；后续 [ADR-013](ADR-013-uncertainty-review-and-request-history.md) 的明确人工确认可允许另行发起新工作，原 unknown/Run/授权不恢复。succeeded receipt 保留实际已确认前缀，不因后续 Run 失败而被改写。

Run 正常 finish 不能遗留未终结 intent。暂停/取消挂起 Run 需在同一事务终结未派发 intent 与 Run；已 dispatch 的未知事实不改成 cancelled。普通 read 不执行这些转换；只有 main-owned 显式 startup recovery/控制命令可写。

## 持久层与应用层边界

Repository 校验 core continuation、call 对应关系、digest、列/数据/owner/时间/revision、一条活动 intent 与 append-only history。数据库一致性不替代 main 的实际 revalidation；approved row 本身不能当作 permission。主进程必须在实际 execute 前 claim，成功后持久 ack；dispatch 后任何无法确认的失败保守记 unknown。持久化失败 fail closed，不重发请求来掩盖未知结果。

runner 的 `resumeApproved` 已通过同一个 Run 的 store/service reopen、重新 prepare、decision 前后配置变化、admission、Stop/Quit、late initialization、一次批准不可复用和 receipt commit failure 测试。配置绑定从 invocation 准备时捕获；变化不能在保存 pending 时静默重标为新 policy revision。`record_progress` 必须最后调用，提出结果后不再准备新的外部请求，避免在新的 approval boundary 丢失未提交结果。

正式 Web port、focused IPC 和正常 UI 已验证 search → pending page → Quit/reopen → approve → 同 Run 产出真实 page evidence；拒绝原子终结 intent/Run，准确 source receipt 由 main 打开。见 [ADR-010](ADR-010-dot-web-research.md)。子进程 marker/网络 fixture 不代表真实服务验收；明确 unknown 人工确认与历史浏览见 ADR-013；完整监督通知与跨 Run 自治仍未完成，不能将这一切片当作完整 Dots。
