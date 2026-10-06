# ADR-003 Agent execution semantics

Status: implemented locally, pending review. Date: 2026-10-03.

Core 拥有固定 system policy、execution states 与 model/tool/permission loop。默认 12 model turns、32 tools、180 秒 active execution、每次 approval wait 300 秒、总 wall clock 900 秒；并列工具顺序执行。工具失败/拒绝作为 tool results 回流，终态区分 completed/failed/cancelled。

2026-10-04 v1 增量：`maxExecutionMs` 明确定义为 active execution，审批等待暂停该计时且不会补充已经消耗的时间；等待和整个任务另有不可无限延长的预算。desktop composition root 显式采用 24 turns / 64 tools / 600 秒 active / 300 秒单次审批 / 1800 秒 wall clock。所有预算由应用配置，不从模型工具参数接收。超时传播相同 AbortSignal，保留工具清理、结果配对和真实 partial journal 语义；不自动重新执行。

Stop 向所有 adapter 传播 AbortSignal。模型与授权等待及时取消；tool execution 必须完成清理后返回。所有未执行 tool calls 补齐明确结果，保留主动 Stop 的部分文本。Restart 不恢复动作，只标 interrupted。当前 main 同时一个 active task，避免权限/资源竞争。

主进程 vault/scope 初始化另限 30 秒，耗时从 desktop wall clock 扣除。Stop 可停止等待不可原生取消的 OS 凭据操作；晚到回答不能修改 scope、重新加密保存或启动模型。Tool history 配对校验在所有请求上执行，短上下文也拒绝缺失、孤立或重复 result。网络拒绝独立记录并阻止后续 network effects，包含带 network.fetch 的 shell；不能通过转换工具绕过拒绝。受控研究的范围与逐请求 main approval 见 ADR-007。

2026-10-04 context 增量：core request 预算默认 192 KiB，至多 1 MiB；只在超限时按完整消息/工具组压缩较早历史。摘要请求没有 tools，使用同一 ModelPort、AbortSignal 和执行预算，并为正常续轮保留 turn。最新用户请求和最新完整组原样保留，观察到的 source receipts 作为单独的 metadata catalog 保留，main 在新任务中提供未过期的 retained source metadata。完整会话与审批账本不被摘要替换。摘要为执行私有数据，不 publish、不持久化；返回 tool calls、空结果、非 stop finish 或 UTF-8 超限即失败。摘要只提供上下文，不授予或恢复权限。不可分组的大输入停止，不制造工具结果或 silently truncate。真实摘要精度与各 provider token limit 仍需单独验证。
