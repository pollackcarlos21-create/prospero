# ADR-007: Bounded research authorization

状态：当前实现采用；真实服务验收尚未完成。日期：2026-10-04。

## 问题与决定

多篇论文研究需要若干查询与来源抓取。逐请求批准造成重复操作，通用 network allow-session 又不能表达用户批准的范围。采用 main-owned、一次执行内有效的 research snapshot，而不修改 ModelPort/provider 协议或放宽 core 的 external permission 要求。

模型通过 `authorize_research` 提议 title、确切 queries/maxResults、maxFetches、maxResponseBytes 和 lifetimeSeconds。Main 生成 execution/conversation binding、id、createdAt/expiresAt、SHA-256 digest，并冻结全部 snapshot。最多 12 queries、每查询 10 results、24 fetches、16 MiB body、15 分钟。每查询只能运行一次；失败请求也消耗次数，不自动重复。Main 保存 prepared audit 后才呈现预览。UI 的窄 `decideResearch` 必须匹配当前 request 和 digest；过期不能批准，不能使用 legacy decision 或 allow-session。

## 执行与权威

一次批准只允许 scope 内的后续 `web_search` 与 `fetch_source`。成功搜索实际返回的 source ID/URL 由 main-owned receipt map 注册；模型、保留 metadata、网页正文、其他 execution 或序列化 snapshot 都不能生成 authority。`fetch_page` 不得作为范围内的任意 URL fallback；一次 run 不能更换 scope，任意 web denial 阻断本 run 的全部 web tools。

Prepare 精确匹配 query/result cap 或已发现 source，预留次数及剩余 body budget，返回同一实例的 opaque one-use reservation。Core 仍强制调用 PermissionPort。Main 仅在 private prepared call 身份、不可变 preview、call 字段与 permission key 都匹配时自动返回 allow-once；renderer 提供的副本无效。Execute 前再次验证实例、批准、expiry 和唯一 dispatch latch，再保存 started audit、执行 I/O。不得把 started 当作 HTTP 成功。

Search 单次至多 512 KiB；fetch 含全部 redirects 至多 2 MiB，均进一步受 reservation 的 remaining budget 限制。Web transport 在读取和 Content-Length 检查时应用 cap，adapter 为每个完整 body 回执原始 bytes。成功后再结算并保存 completed audit，之后才能把 source evidence 返回模型；audit failure fail closed。Partial/未知失败按全部 reservation body 额度记账，不免费重放。这个额度不含 TCP/TLS/HTTP headers，也不能保证远端是否计费。

Expiry deadline 与 Stop 会 abort 请求 signal；close/revoke 使 grant 与来源映射失效。晚到结果不能授予来源或修改权限。授权与 reservations 不持久化为可恢复 grant；SQLite conversation snapshot 仅保存最多 20 个研究计划的 frozen preview 与 bounded events。崩溃后未关闭的 prepared/approved record 增加 interrupted event，不自动恢复请求。

## 数据与相邻流程

`@prospero/web` 不接触文件、shell、SQLite 或 vault。页面无 credentials/cookies，逐跳 URL/DNS/IP/TLS validation 沿用。网页内容保持 untrusted，只在当前模型执行内使用；main 的消息/工具持久化及 renderer IPC 去掉 raw body。Source metadata/excerpt 沿用 session/七天 retention；query、title 和审计仍属于明文 conversation，不构成通用擦除保证。

Web Search 的 Test Connection 是独立固定-query probe：draft 或 main-decrypted stored key，仅一次 `Brave Search` / maxResults=1，不保存配置、启用搜索、创建来源或返回 response body。15 秒 deadline 包含读取 vault。Web config/probe 保留同一 busy reservation，不能与 task startup 混用。

Task 启动的 vault/scope 初始化限 30 秒，并扣减总 wall clock。Stop 可停止等待原生解密，SecureCredentialVault 在每个异步返回后检查 signal；晚到结果不 reencrypt/save 或启动工具。该机制不承诺物理取消 OS 弹窗，且不在取消后解除仍进行中的配置写入 reservation。

## 结果与限制

无需 renderer 通用 network RPC、shell 网络绕过或 new runtime package。一次批准仅覆盖 exact manifest，临时网络失败需使用已有清单内的其他未使用查询，或用户明确新任务重新批准。PDF/OCR、网页交互、后台运行与自动回滚不在此决定内。离线 fixtures 可验证协议、安全和生命周期；真实模型自主研究、真实 TLS/Brave compatibility 仍需获授权的单独验收。
