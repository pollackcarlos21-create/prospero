# ADR-002 OpenAI-compatible model boundary

Status: implemented locally, pending review. Date: 2026-10-03.

Core 的 ModelPort 只描述 model-neutral messages、tool definitions 和 streaming text callback。Provider 使用 raw fetch 实现 Chat Completions/SSE，base URL/model/key 在 main composition 注入，wire types 不进入 core。不引入 OpenAI SDK 作为领域抽象。

支持 standard tool_calls、明确协议失败、Abort/deadline/output limits；兼容差异留在 adapter。远程 HTTPS、loopback 可 keyless、禁重定向。Connection probe 优先 models，有限 fallback。没有真实 credential 时离线验证继续，真实服务兼容另列边界。
