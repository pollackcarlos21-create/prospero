# ADR-012: Durable one-shot wake and restart-aware dispatch

状态：已实施，离线专项与正式 Electron 垂直切片通过。日期：2026-10-19。

UI 明确创建一次未来唤醒，绑定当前 immutable research policy ID、stable wake ID 与 UTC dueAt。它不修改 policy、不重置预算，也不授权模型自行扩展 recurrence。Scheduled wake 是 eligibility，不是已执行；timer 仅提示 main 重新读数据库。

同一事务完成 scheduled → claimed、Dot/Run pair 创建和 model reservation，commit 后才初始化模型。重复 timer、重启或并发 claim 不得创建第二个 Run。未知/已 claim 的执行不自动 retry；原 policy 被撤销、到期、变更或额度不足时保存 blocked reason，不降级成自动 manual Run。

暂停、停止、取消、完成、归档或撤销授权取消未 claim 的 wake；Resume 不复活旧 schedule。关闭窗口保留 main-owned scheduler，Quit dispose timers/observers 并停止当前执行。重开 App 后，仍有效的 overdue one-shot 最多 catch up 一次；App 已退出期间没有 daemon。

调度复用现有 shared admission、policy continuation controller 和 core runner。Busy 或等待审批时保持原 intent，slot 释放后重查；不通过 0ms timer 空转。Timer 最多 30 秒重新核对 UTC，sleep/resume 时立即扫描；时间倒退时不提前执行。采用可注入 scheduler clock 和临时 DB 验证 advance/jump/busy/dedup/restart，不用不稳定 sleep 猜测行为。


schema v7 只增表/索引/约束，迁移不清理无关 TTL 数据；credential copy 兼容版本同步，并证明包含实际 wake 的源 profile 未修改、选定凭据副本没有 Dot 私有记录。wake binding/digest 与 column、policy owner/expiry、claimed Run createdAt/policy reservation、两条以内含 Run ID 的 append-only event 相互校验；read 不自愈坏数据。

新增独立子进程竞争和 commit 前后退出案例，证明 wake/Run/model reservation 无半份提交、CAS 只产生一个 winner、恢复 interrupted Run 不重放原 wake。初始化失败发生在 pending 时保存 interrupted；不执行非法 pending→failed，也不自动重试。Fake clock 证明 backwards/forward jump、busy、重复扫描、控制与 dispose 的边界。原有 Chat、默认 core runtime 和安全边界继续运行完整回归。

本轮将 M012 的持久 intent 和 M014 的最小 main driver 一起验证，原因是单独存储 dueAt 不能证明实际唤醒语义；没有建立第二套 agent loop、通用 workflow 或 daemon。M013 正常 UI 与 M015 window lifetime 沿用现有实现。此切片不授权模型自行安排新 wake、周期 recurrence 或 App 退出期间运行。

撤销与拒绝只终结对应 policy 的 pending wake，不因其他 Dot 的坏记录阻碍当前用户撤销。单列 Run ID 损坏即使指向同 owner/policy/createdAt 的另一条合法 Run，也必须被 immutable claim event 拒绝，不能只靠时间匹配证明关联。
