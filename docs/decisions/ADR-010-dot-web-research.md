# ADR-010: Dot-owned bounded Web research

状态：正式 main/service、focused IPC 和正常 Dots UI 已接入，离线受控研究闭环和完整回归通过。跨 Run 自治仍未完成。日期：2026-10-19。

## 单次研究与权限

Dot 使用已有 `BraveWebClient` / `TavilyWebClient`、public HTTPS/DNS/IP/TLS/redirect/body 限制，独立于 conversation 的 Web host。首个正式切片仅提供 standalone `web_search` / `fetch_page`，每次准确请求走 ADR-009 durable approval；不伪造 conversation ID、不恢复旧 research grant、不开放 file/shell。后续自动研究 policy 仍须独立实现，不能将启用 Web Search 当作网络批准。

每 Run 最多两次搜索、两次页面读取；每搜索最多五条结果、256 KiB body，每页面含 redirects 最多 1 MiB body。总 body 最坏上界 2.5 MiB；已 dispatch 的请求计入预算，失败不免费重放。相同规范 query/URL 的已派发请求在同 Run 不重复，改 result count 不能绕过。次数从 durable intent ledger 读取，挂起、窗口关闭和进程重启不重置。跨 Run 累计预算与重复授权仍属后续 policy 阶段。

准备无网络 I/O；预览显示完整 query/URL、结果/字节上限。实际 execute 前由 runner 重新核对 provider/configuration 与 preview，再持久 claim，网络端口才可工作。拒绝准确请求与取消 Run 在同一事务提交。外部失败或缺失 durable acknowledgement 保留 unknown，阻止新 Run，不推断动作未发生。

## 凭据与窗口

主进程通过现有 endpoint-bound vault 读取配置的搜索凭据；Dot 读取拥有独立于窗口的 credential ownership，并在整个 research session 保持 Web configuration reservation。逻辑取消后仍保留实际 native reservation 直到 native settlement；晚到结果不创建客户端或派发请求。已初始化 session 由 runner 的 finally close/release，Quit cleanup 包含模型和 Web session。

configuration fingerprint 覆盖当前 Web Search 设置与 encrypted credential representation，仅作失效绑定，不是 policy grant。重新加密也可能保守失效旧批准；不静默沿用变化前的权限。已知搜索/模型密钥不能进入 query、URL、结果或 checkpoint proposal；renderer 从未收到 key、ModelPort、WebClient 或泛化 network RPC。

## 证据与保留

模型使用实际返回的 untrusted search/page text。挂起前移除已经完成的 Web tool response body，仅保留不带正文/摘录的来源元数据；pending 占位和 deferred suffix 保持精确配对。保留的 source metadata/ID 从不单独授予下一请求的权限。

有界 receipt 保存 response byte count、source ID/URL/title/kind/time/hash，excerpt 固定为空；字段、owner、digest、UTF-8 大小和 event sequence 均经 rehydration。审批/执行历史保留，Settings 明确区别 source previews retention 与 request history。Source 打开必须通过 Dot/intent/source identity 查到实际 succeeded receipt，再使用 main 的 native open；不接受 renderer 提供 URL。

Dot、Run、checkpoint 和当前 Run 的 intents 在一个 read transaction 内形成 snapshot。Application 明确投影安全 DTO，不把 continuation/history/provider secrets 随 spread 传入 renderer。成功回执的时间不得晚于 terminal Run；时钟倒退时 recovery 按实际已记录回执时间结束 Run，不能提交自相矛盾的历史。

## 界面与验证

正常 UI 展示 waiting approval、准确预览、批准并继续/拒绝、已批准后继续、到期说明、折叠的结果回执和来源打开按钮。新请求需要新批准；关闭 App 重开保留相同 Run 和待批准 page request。Web 未配置时明确说明只能起草笔记。Unknown 可查看且继续被阻断；完整人工解除门、跨 Run 活动检索、repeat policy 和 scheduler 仍需后续实现。

验证使用真实 SDK、safe Web adapter、SQLite、正式 preload/IPC/renderer 和临时 profile；网络及 native crypto/browser 打开仅替换为显式 offline seams。模型第二步从实际 page body 派生结果，首个 search 回执不能冒充 page read。另覆盖无网络 prepare、预算/重复/密钥/private URL、parallel tool suffix、native credential window/cancel ownership、拒绝事务 rollback、时钟倒退与 source owner。它证明受控链路，不能当作真实搜索服务/TLS 或真实模型研究质量验收。
