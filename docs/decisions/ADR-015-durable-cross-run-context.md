# ADR-015: Dot-owned cross-Run context from durable evidence

日期：2026-10-22。状态：已实现，正式 service/core 与正常 Electron 专项通过；最终完整质量门见 DOTS-DELIVERY。

此前每个新 Run 只消费最新成功 checkpoint。如果搜索已成功落 receipt，而模型随后未保存 checkpoint、取消或中断，下一 Run 看不到这部分持久事实。重新搜索会浪费额度，也可能掩盖旧请求的未知结果。当前阶段让模型和用户读取同一组 Dot-owned 历史事实，保留成功请求与整个 Run 成败之间的区别。

## Read ownership and snapshot

复用既有 schema v9，不创建新 memory database 或通用 workflow。`DotRepository.context(dotId, query)` 在一个 SQLite read transaction 中读取该 Dot 的 terminal Run、属于该 Run 的 checkpoint、准确 intent 与对应人工 review；采用现有严格 rehydration、column/payload、owner 和时间检查。每页至多两个请求，按 createdAt/id 倒序；总数至多遵循既有单 Run 200 intent 的 guard。读取不恢复、修复、approve、dispatch、revoke 或创建 Run，也不追加 alert、policy usage 或 checkpoint。

默认选择最新 terminal Run，pending/running 的新 Run 不遮住此前工作。`runId` 读取准确的 terminal Run；`beforeRunId` 读取该 terminal revision 之前的一步，二者互斥。`olderRunId` 可以直接用作下一次 runId；terminal Run revision 不因后来新 Run 或人工 review 而增长，因此新工作不会推动显式选择的历史游标。所有游标均验证 Dot owner 和 terminal 状态；外部 Dot、in-flight、坏 ID、未知 query 字段、accessor 和无效 offset 被拒绝。`requestOffset` 在选定终态 Run 内分页，新的 Run 不改变其顺序。返回的 dotRevision 表明观察时刻；review 可以后来追加，重新读取才会出现新备注。

## Bounded human/model projection

主进程 `readDotContext` 显式投影 `DotContextView`，模型内部 `read_dot_context` 和窄 IPC `dots.context` 使用同一函数。没有 raw continuation、原始 tool arguments、provider config、credential retrieval 或 Web body。请求保留 ID/status/tool/时间、query/URL 摘要、receipt summary、实际 sourceCount、至多两个 source metadata 与人工检查备注。source metadata 保留准确 ID/hash/kind/检索时间；标题可截短，超过单条 1536 字节的 metadata 会省略并标明 truncated。可从正常用户界面通过原有 main-owned openSource 检查原 source，所有准确请求和完整 checkpoint 仍在已有历史入口。

页面序列化上限 24 KiB；checkpoint summary 上限约 2 KiB，completed/next 各至多五条、每条约 256 字节，request query/URL/receipt summary 约 512 字节，review note 约 1 KiB。截短预算包含 JSON escaping，按 Unicode 字符边界截断，并明确标记 truncated；不覆盖任何保存原文。单条 source 的身份/hash 完整保留或整体省略。异常超限 fail closed，不能无界扩大模型上下文。

新 Run 继续收到完整 latest checkpoint，同时自动带入至多 8 KiB 的最新 terminal context seed。seed 不重复 checkpoint，可减少请求条目以保留原模型输入预算；requestCount/offset 仍提示可通过内部工具继续查询。实际工具查询仍消耗原 12 tool calls / 8 model turns / 96 KiB 等 Run 限额，不启用新 loop 或额外预算。准备与执行均为只读，execute 重读当前快照；record_progress 后不能再读历史或执行研究，保持本步 proposal 结束语义。

## Evidence is not authority

历史工具结果不返回 core ToolResult.sources：旧来源不能变成当前 execution 的新搜索/页面回执。未保存 page body，不能声称重新阅读了原文；旧 source retrieval time 不证明当前仍有效。已有 scope、fresh prepare、准确请求审批、policy binding、预算与 unknown gate 保持不变。人工检查只提供检查备注，unknown 不会转换为 succeeded，不允许自动重放。当前已知 model/search credential 不能出现在新模型 request 或历史 tool response；先检查投影/消息的原始字符串，再序列化，避免引号、反斜杠等 escaping 隐藏完整密钥。发现时停止本步，不传给 provider。

用户的 Saved context 折叠视图是延迟只读查询，显示 Run 状态、已有工作/next steps、请求成功/unknown、人工备注和 source 类型。用户可分页/查看更早 Run/刷新，不会开始执行。切换 Dot 后丢弃旧异步读取，dotRevision 变化时提示刷新；无窗口继续与审批通知不受该视图影响。

## Verification and remaining work

专项通过实际 core suspension、exact intent dispatch 和临时 SQLite 验证：成功请求属于 failed Run、无新 checkpoint、重开 profile 后新 Run 消费旧回执且零研究重发；unknown 人工确认后仍为 unknown；跨 Dot/in-flight/accessor/offset 拒绝；新增 Run 不移动旧游标；请求分页不改变 ledger；多语言/escaping 摘要上限与原文保留；损坏 receipt/Run/checkpoint 拒绝；普通文本及含引号/反斜杠的已知 model/search credential 均不进入模型请求。Renderer 专项验证延迟读取、分页、只读来源入口和切换后的迟到读取。

正常 Electron 用生产 provider/Web clients 与临时 profile，fake HTTP/OS crypto：UI 搜索成功后故意不保存 checkpoint → Quit/reopen → 用户查看旧 failed Run 与 succeeded search receipt、打开原 source → 正常 Run 通过 read_dot_context 读取该记录并写新 checkpoint → 刷新/查看旧 context。全程只有一次 Web request，第二 Run 没有新 intent；没有 Chat conversation，也没有将历史来源导入当前 core source receipts。此证据是离线工程验证，不是实际模型研究质量验收。

模型工具目前不提供完整 checkpoint 的分段读取或单个 receipt 内的 source 分页；完整原记录仍可通过用户历史入口检查，后续检索需补齐这两个入口。页面正文没有持久保存，不能通过此工具取回。

仍未完成独立的长期 memory 编辑/检索、用户补充上下文、持久 tasks/planning、artifact/versioned results、event/dependency triggers、主动成果判断与真实服务质量。这个阶段建立现有事实的可查上下文，不能把它等同于完整长期记忆或完整 Dots。
