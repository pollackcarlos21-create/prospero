# ADR-011: Revocable repeat research policy and cumulative reservations

状态：domain、schema v6 ledger、正式 runtime/controller、IPC 和正常 UI 已接入并通过离线验证。日期：2026-10-19。后续一次性 wake/scheduler 已沿用该边界接入，见 ADR-012。

用户明确授权 exact queries/result caps、是否允许读取该授权搜索实际发现的页面、provider/configuration binding、expiry 和累计 Run/model/search/page/body 上限。Policy 不含 file/shell/native 权限，不由模型创建或扩大；scope/budgets 不可变，变更必须撤销后重新明确授权。启用 Web Search、旧 checkpoint、source metadata 或单次批准均不是 repeat grant。

使用现有 core suspension 和 durable intent：每个工具先挂起并保存准确 intent，policy 只能为匹配的请求保存独立批准证明，随后通过同一个 runner 的 fresh prepare/permission/dispatch。不能恢复 PreparedTool 或直接绕过 core 调用网络。数据库在同一事务中检查 active/expiry/binding/remaining budget、charge 和 dispatch claim；未知结果保留、阻断并撤销原 policy。拒绝和撤销阻止后续自动派发。

Model 成本以 conservative reservation 约束：每新 Run 预留至多 8 model turns × 96 KiB core request bytes，包含 context compaction，挂起/重启继续同 Run 不重收也不重置。每 Web dispatch 预留 256 KiB / 1 MiB，覆盖失败与未知窗口，不自动退款。总请求/token/货币成本不等同于这些 core turn/body/request-byte 上界，UI 须说明模型按 Run 预留。Usage 是 append-only ledger 派生事实，不依赖可重置的 in-memory counters。

Policy revision 只用于显式控制（active → revoked）；usage ledger 追加不使用户的撤销按钮持续因计数更新失效。Current grant 与 Run binding、automatic approval proof 独立持久化；SQLite 单事务/CAS 控制并发。UI 可查看 scope、累计 reservation、expiry 和撤销；暂停/取消不能派发，Resume 不重新授权或重置预算。

Application pump 已接入，只为 policy-derived、尚未 dispatch 的准确 intent 取得共享 admission 并继续；manual approved row 不被当作自动 resume intent。共享 slot 释放触发一次排队检查，仍调用原 `resumeApproved` / `core.runAgent`；一个 intent 每次 app lifetime 自动初始化至多一次，失败后保留未消费批准供明确重试，不能 0ms 无限 retry。退出先 dispose observer/timer 再停止 runtimes。ADR-012 的 wake/scheduler 复用这些边界，不创建第二个 agent loop、daemon 或通用 workflow engine。

正常 UI 提供 exact-query form、max Runs/search/page/body、expiry、model reservation 说明、当前范围/累计 reservation 和撤销。原授权撤销后不产生自动派发；用户另行点击新 manual Run 是新的有限请求，仍逐工具批准，不使用原 policy。持久审批与回执始终保留。Native offline E2E 验证两次 Run 中途重启、实际 checkpoint 消费、累计计数、第三次 Run 零新增模型/Web请求、撤销后恢复人工批准；未知结果仍阻断，完整人工解除门在后续监督阶段。
