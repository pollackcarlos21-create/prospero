# @prospero/web

Prospero v0.2 的独立 Web adapter。包仅负责搜索、公开 HTTPS 文本读取和来源验证；不依赖 `core`、ModelPort、Electron、文件工具或持久化。主进程持有 `WebClient`、解密搜索凭据并决定内容 retention。Renderer 不取网络、读取凭据或传入网络选项。

```ts
const client = new BraveWebClient({ apiKey });
const sources = await client.search(query, { signal, maxResults: 5 });
const page = await client.fetchPage(sources[0].url, { signal });
// Tavily keeps the same WebClient contract and safe page-read path.
const tavily = new TavilyWebClient({ apiKey: tavilyApiKey });
```

`WebSource` 区分 search snippet 与实际 page body，提供 canonical final URL、title、ISO `retrievedAt`、正文 SHA-256、绑定 kind/URL/hash 的 `src_...` ID、≤ 1200 字符 excerpt 和临时 `content`。主进程可将 ISO 时间转换为自己的 epoch-ms 字段。正文不是指令：`trust` 固定为 `untrusted`，`sourceForModel()` 使用 JSON 编码和明确的数据提示。Prompt injection 的最终权限防线仍是 main-owned effects/scopes/approval；文本标记不是安全边界。

`resolveCitation()` 只接受实际取得的唯一 source ID，并复核 canonical URL、hash 和 ID 绑定，返回来源记录中的 URL；不接受模型提供的 citation URL。ID 不代表页面真实性或事实正确性，hash 仅标识本次抽取的文本。

Brave adapter 使用固定 `GET https://api.search.brave.com/res/v1/web/search`，认证 `X-Subscription-Token`，`q` 上限 600 字符 / 75 words，`count` 范围 1–20。只请求 `web` results，关闭 text decorations。搜索请求不跟随 redirect；凭据从不用于 page fetch、正文、错误信息或来源记录。认证、rate limit、网络、超时等错误都映射固定 safe code/message，不保留服务端错误正文。HTTP/private results 被丢弃，不隐式升级为 HTTPS。

Tavily adapter 使用固定 `POST https://api.tavily.com/search`，认证 `Authorization: Bearer`，保留同样的查询和结果数量上限。JSON body 固定 basic search，关闭 `include_answer`、`include_raw_content` 和 `auto_parameters`；只把 `results` 中的 URL、title、content 映射为 search snippet，不使用服务端生成的 answer 或 raw_content 充当实际页面读取。凭据不进入 request body；搜索同样不跟随 redirect、不抓取 unsafe URL，复用相同的 DNS/pinning、超时、取消、body cap 和安全错误处理。内部 main-owned transport 仅支持 GET 和 body ≤ 16 KiB 的 POST；GET 不允许 body，POST 发送前复制 body。

公开 fetch 仅支持 HTTPS、443、无 userinfo 的 GET。它拒绝 localhost、单段/本地名称、private/loopback/link-local/shared/multicast/reserved IPv4，以及 IPv6 mapped/tunnel/local/special ranges；只允许保守的 global-unicast IPv6。每次连接和每个 redirect 都检查全部 DNS answers，再把所选公开地址 pin 到 HTTPS lookup。独立连接保留原 host、TLS certificate verification、SNI 和 socket remote-address 验证，不使用环境 proxy、cookie、Authorization、请求池或页面指定 headers。

网络 deadline 默认 15 秒，配置上限 30 秒，覆盖 DNS、redirect 和 body；Abort 关闭请求/响应。最多 5 次 redirect。页面累计 ≤ 2 MiB，搜索 ≤ 512 KiB；请求 identity encoding，拒绝压缩与非 HTML/非 UTF-8 页面。`parse5` 8.0.1 只解析，不执行 JS、不加载任何资源。抽取优先 `<main>` / `<article>`，否则 body，跳过 script/style/form/template/iframe/embedded media/导航/hidden 内容；正文 ≤ 80,000 字符。第一版不处理 PDF、登录页、动态浏览器渲染或其他 charset。

生产默认使用 Node 内建 DNS/HTTPS；测试只注入 main-owned 窄 resolver/transport/request-factory，不增加 loopback、TLS bypass 或 endpoint override 开关。单测覆盖混合 DNS、rebinding、redirect、两家搜索服务的 header/credential isolation、GET/POST wire contract、正文大小、script/form 剥离、cancel/deadline、citation forgery 和原生 HTTPS 连接选项。新增 Tavily adapter 的验证使用离线 fixtures；真实服务/API 试用与正常桌面任务验收须另行记录，不能由这些单测推导。

官方依据（2026-10-04 查阅）：[Brave Web Search reference](https://api-dashboard.search.brave.com/api-reference/web/search/get)、[Brave authentication](https://api-dashboard.search.brave.com/documentation/guides/authentication)、[Node HTTPS](https://nodejs.org/api/https.html)、[Node BlockList](https://nodejs.org/api/net.html#class-netblocklist)、[parse5](https://github.com/inikulin/parse5)。

Tavily 契约依据：[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。
