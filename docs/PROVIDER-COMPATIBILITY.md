# Provider compatibility

Prospero supports OpenAI-compatible Chat Completions APIs.

```text
Base URL: https://api.example.com/v1
API key: stored securely
Model: example-model
```

## Supported contract

- Raw `fetch`：`POST /chat/completions`，model/messages/stream=true。
- 标准 function `tools` 与 `tool_choice=auto`；provider settings 可关闭 tool capability。
- `text/event-stream`，content deltas、按 index 聚合的 tool_call deltas、finish_reason 和可选 usage。
- 增量 UTF-8 decode、CRLF、SSE comments、多 data lines、可选 usage-only 空 choices chunk。
- 明确 completion finish 必须存在；clean EOF 可在 finish 后结束，[DONE] 可选。
- finish `stop`/`tool_calls` 为常规路径，`length`/`content_filter` 安全停止；未知协议明确失败。
- request timeout、user abort、stream size limit；不 silently repair 非法 JSON、missing choices、legacy function_call 或 malformed tool protocol。
- reasoning/reasoning_content 等字段不会显示，也不保存 private chain-of-thought。

## Endpoints and authentication

URL 规范化去尾部 `/`，也接受用户误填完整 `/chat/completions` 或 `/models` path 并移除该末段。不会给 root endpoint 自行添加 `/v1`。拒绝 URL 内 username/password/query/hash。任意远程 HTTPS 可配置；HTTP 仅 loopback。无 key 的 loopback 请求省略 Authorization；远程无 key 连接失败。重定向禁止，避免 credential 转发。

Test Connection 先 `GET /models` 验证标准 JSON data list；404/405/501，或成功响应无法解析为含 `data` array 的 JSON 时，请求最多一个输出 token 的 nonstream completion。401/403 显示 Authentication failed，且不触发回退；429/500 类别安全映射；错误 body 不显示。

Saved key 的 OS-encrypted envelope 绑定 provider id/规范化 endpoint，metadata 保存失败或重启后的绑定不符会拒绝发送 HTTP 并要求重新输入 key。旧格式在首次成功读取时按已有配置迁移。配置保存及模型 Test Connection 包含 native credential 等待的逻辑上限为 30 秒；native promise 未 settle 时仍禁止同 provider 重绑，关闭应用不会把晚到结果送往旧地址。这些 main 生命周期规则不改变 Chat Completions wire contract。

## Verification boundary

离线协议测试涵盖 UTF-8/chunk/text/tools/finish/usage、401/429/500、timeout/abort、malformed SSE/JSON/choices。Desktop E2E 使用真实 localhost fake server。真实 OpenAI/DeepSeek/第三方服务是否工作，需要有 credential 的有限 smoke；fake protocol success 不证明全部服务兼容。

Core 已实现 bounded execution-only context compaction，仍使用现有 ModelPort/Chat Completions，不新增 provider summary wire dialect；摘要请求不带 tools，也不能拥有执行授权。真实摘要保真和不同 provider 的 token 预算尚未验证。未实现：Responses API、custom headers、provider-specific reasoning payload、multimodal、legacy function_call、自定义 tools wire dialect。若某服务需要特殊行为，放在 provider adapter，不要进入 core。

## DeepSeek current models

2026-10-06 核对官方 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)：当前模型 `deepseek-flash`、`deepseek-v4-pro` 默认开启 thinking；该模式的连续工具调用要求回传 reasoning_content。Prospero 的 ModelPort 不承载这些私有字段。

因此仅对官方 `https://api.deepseek.com` 的 root、`/v1`、`/beta` 和上述两个准确 model 名称，provider 在 streaming completion 及 Test Connection 的 completion fallback 中显式发送 `thinking: { type: 'disabled' }`，使用现有非 thinking 多轮工具协议。正常工具调用、摘要、取消和 key endpoint binding 保持原有边界；不保存或展示私有推理。第三方兼容 endpoint、相似 hostname 和其他 model 不注入 DeepSeek 参数。

离线端口回归验证请求参数与工具结果 continuation。2026-10-06 授权小试用中实际 `deepseek-flash` streaming completion 返回 HTTP 200，回答一句公开问题；这不证明正常桌面工具循环或完整研究质量。完整 thinking payload 支持仍延期。

## Brave Search / Tavily

搜索与模型 provider 分离。Settings → Web Search 显式选择 `brave` 或 `tavily`；旧配置缺 provider 时默认 Brave。密钥分别绑定 `brave-search` / Brave endpoint 和 `tavily-search` / `https://api.tavily.com/search`，仅 main 解密。不根据 key 前缀自动切换，不回退到另一供应商的 key。

Brave 使用既有 GET；Tavily 使用固定 endpoint 的 POST Bearer 与 basic 搜索，关闭 answer、raw_content 和 auto_parameters。两者返回现有 search source；页面仍由 Prospero 的独立安全 GET 提取，不能把 Tavily 摘要声称为已读网页全文。Tavily 协议依据 [官方 Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

Web Search Test Connection 只执行一次固定 `Prospero web search` 查询（maxResults=1）；支持所选供应商的 draft 或 stored key，15 秒上限包含取凭据，不保存设置/来源，不返回 response body，可能消耗额度。状态文案指向实际所选供应商。测试不包含 page fetch，不能代替研究任务验收。

2026-10-06 授权小试用中直接固定 endpoint 的 Tavily 请求返回 HTTP 200；正常产品的 adapter、审批和来源链另由离线测试验证。早期本机 arXiv 与 `api.tavily.com` DNS 返回 reserved/private addresses，默认安全读取在 HTTP 前拒绝；未绕过检查。用户随后亲自试用，确认产品已经可以联网并接受本轮目标。该人工确认没有逐项任务记录，固定真实整轮仍为 pending，见 [V1-VALIDATION](V1-VALIDATION.md)。
