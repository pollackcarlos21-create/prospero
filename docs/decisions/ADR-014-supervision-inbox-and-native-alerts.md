# ADR-014: Durable supervision inbox and native alert attempts

日期：2026-10-22。状态：已实现，离线专项与正常 Electron 垂直切片通过；最终完整质量门见 DOTS-DELIVERY。

Dot 请求需要人工批准/继续，或 external outcome 为尚未确认的 unknown 时，用户离开 Chat 或关闭全部窗口仍应知道需要检查。提醒只导航到原 Dot，不批准、不确认、不创建 Run、不继续旧 continuation，也不初始化模型或解密凭据。

待处理列表由原持久 intent/review 派生。`DotApplication.supervision()` 分页读取、严格校验活跃 Dot 的候选，过滤已经人工确认的 unknown、正在运行/settling 的请求，以及原 policy、剩余额度、deadline 和当前 provider/configuration 均仍匹配且尚可自动继续的请求。分类是只读，不调用 approve。自动初始化已经尝试但未能继续时仍需人工检查；隐藏的自动候选在 deadline 前由有界 timer 复查，系统 resume 也立即刷新。

主进程只发布最多 50 个待处理条目及 more 标记；处理后后续条目进入列表。DTO 只有 identity、kind、revision/digest 和时间，没有 goal/query、raw arguments、continuation、source body 或 credentials。快照序号防止晚到初始读取覆盖新列表。点击列表或原生提醒均以原 Dot identity 打开正常界面；不创建 Chat conversation，不消费 approval。新窗口使用现有 renderer-ready 排队机制，重开窗口后重新读取真实持久状态。

schema v9 增加 immutable `dot_alert_claims`，以 `(intent_id, kind)` 为唯一键，绑定 owner、intent revision/digest、main 时间。kind 区分 approval 和 uncertain，同一请求从待批准变成未知结果可以各提醒一次。批次最多包含 20 个未 claim 条目，生成一条通用原生提醒；每条 claim 表示纳入该批次，不等于一条独立 OS banner，不能把行数当作 OS 投递数。

claim 在事务中重新读取 active/未解决状态并核对准确 binding；陈旧、已确认、已暂停等快照不产生新 claim。每条已存 claim 也验证原 owner/digest 和对应历史 event，不依赖内存 Set 去重。批次失败整体 rollback，commit 后才调用原生 Notification。Crash/失败发生在 commit 与实际显示之间时可能丢失提醒，不假定未显示、不自动重送。pending/unknown 一直留在持久列表，claim 不是 OS delivered/read receipt，更不是授权。

默认使用静音的 `Prospero / A Dot needs your review.`。不把 Dot name、goal、query、model output、路径、key 或 URL 放入锁屏。主进程检查窗口焦点、原生支持和 Settings 中可关闭的 Dot review notifications；聚焦/静音/不支持时不 claim，待处理列表仍可用。普通 streaming 不触发反复扫描；主进程按有意义的监督状态变化合并刷新，丢弃过时异步读取。OS show 抛错也保留尝试，停止自动 retry；Quit 清理 timer 和旧点击回调。此能力只承诺 main 仍运行时的无窗口提醒；App Quit 后没有 daemon，重启依靠持久列表和去重，而非恢复旧 JS notification resolver。

正常 Electron 验证使用实际 Notification instance/getters/click callback，只替换 OS 显示和焦点接缝，不发送真实 banner 或系统授权提示。覆盖：聚焦与静音抑制但列表可见；无窗口 approval 提醒；点击恢复正确 Dot 且零模型/Web新增；重启去重；人工批准后持有实际生产 Web client 的请求，关闭窗口仍为 dispatching；受控 503 留下 unknown 后独立提醒；再次点击只显示检查入口，仍是同一 Run、一次实际 Web request、没有自动确认/重放。文案明确排除私有内容。

配套测试还验证真实 SQLite 的跨连接去重、不可变记录、坏 owner fail closed、批次 rollback、v8→v9 collision/无关 TTL 数据保留、凭据副本没有私有 alert 行，以及 fake clock 的到期/迟到/dispose。Settings checkbox 使用可回滚的本地显示状态，保存失败恢复原值；焦点循环包含新控件。

仍未完成：长期 context/memory、tasks/planning、event triggers、artifacts、成果显著性与其他主动提醒。此切片只覆盖待批准/需要确认的监督提醒，不能当作完整 Dots、OS 实际投递保证或真实模型任务验收。
