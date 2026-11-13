# ADR-013: Explicit uncertainty review and cross-Run request history

日期：2026-10-21。状态：已实现，专项 core/SQLite/application/UI/Electron 验证通过；最终完整质量门见 DOTS-DELIVERY。

`unknown` 表示外部请求可能发生，不能变成“未发生”、失败可重试或成功回执。人工监督新增的是不可变 `accept-uncertainty` 记录；原 intent/status/digest/events、terminal Run 与历史 receipt 不改写，也不生成 checkpoint。

schema v8 只添加 `dot_intent_reviews` 及不可变约束。记录绑定 Dot/Run/intent identity、准确 intent revision/digest、被检查的 Dot revision、main 时间和最多 4096 UTF-8 bytes 的用户备注。JSON 转义后的持久行上限为 32 KiB，严格 rehydration 和 SHA256 校验列/payload/owner/time/revision。没有任意覆盖、编辑或删除入口。

确认只允许已 terminal 的 unknown Run。main 还须确认该 Dot 的 native settlement 与执行 reservation 已结束；正在执行、挂起待批准或旧 binding 均不能当作 unknown 确认。用户须填备注并明确勾选“请求可能已经发生”，不能用普通批准按钮代替。

`acknowledgeUnknown` 在 `BEGIN IMMEDIATE` 内检查当前 Dot revision、intent revision/digest；记录纯 `recordDotReview` 的 Dot revision +1/时间推进，与 review insert、原 policy 撤销和 pending wake 终结同事务。Dot lifecycle 不变，无 Run 创建。确认前准备的旧 Run 指令因 revision 过期失败，任何部分写入失败整体 rollback。read 验证当前 Dot revision 严格晚于 review 中被检查的 revision，防止单独存在的 review 行打开执行门。

后续新 Run / policy / wake 仍要显式用户请求和最新 revision。所有 unknown gate 按页读取 ID，逐项严格校验 acknowledgement，不因第一批已确认就忽略后续未确认记录；不批量装载整个 continuation 历史。确认不退款、不恢复原 scope、旧 wake 或旧 core continuation，不触发 model/Web I/O。旧 unknown 即使晚到 success，也不能覆写。原授权仍 revoked；单独开始新的 manual Run 仍逐请求审批。

正常 UI 提供只读跨 Run 请求分页（每页最多 20 条）、原 preview、Run/time、dispatch claim、source receipt 和 review note。`DotApplication.requests` 明确投影 DTO；不传出 continuation、raw tool arguments、provider credential 或 SQL payload。来源通过既有 owned succeeded receipt 的 main API 打开。历史详情可折叠，不能在旧卡片上恢复批准；unknown 的灯即使已被用户接受仍为红色，不能显示为任务成功。

验证覆盖：未知 gate、明确勾选/备注、owner/revision/digest/time、原状态保留、跨连接重开、重复确认、坏记录 fail closed、paired Dot/review rollback、stale Run 失效、201 条历史跨页 gate、完整 UTF-8/JSON 转义边界、迁移 collision/无关数据保留和凭据副本隐私。正式 Electron 用一次真实生产 Web client 的离线 503 请求留下 unknown，检查原 policy/wake/预算，确认后 Quit/reopen，证明零自动重放；随后显式新 Run 重新等人工审批，拒绝时零新增 Web，历史可检查两个 Run 的原记录。

仍需后续完成的内容包括：窗口关闭时的监督通知、更完整的 activity/artifact/context、长期规划/记忆与 proactive 策略。这个切片不等同完整 Dots 或真实研究质量验收。
