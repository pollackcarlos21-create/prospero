# Architecture

本篇保留 v0.1 基础分层。v0.2 增加独立无宿主权限的 `@prospero/web`，由 Electron main 与 local-host 组合；effects、scopes、Action Plan 与逐动作 journal 的完整结构见 [V02-IMPLEMENTATION](V02-IMPLEMENTATION.md)。ModelPort 和 Chat Completions provider 继续保留。

Prospero v0.1 的 application composition 位于 Electron main。它是单进程主机下的个人 Agent；主窗口只呈现状态与明确的用户动作。没有 Tempest 提取，也不依赖 Ariel。

```text
React renderer → typed preload API → validated IPC → DesktopService
                                                   ├─ core.runAgent
                                                   ├─ providers.OpenAICompatibleProvider
                                                   ├─ local-host → tools + core contracts
                                                   └─ persistence.ProsperoStore
```

## Ownership

| Owner | 职责 | 禁止依赖 |
| --- | --- | --- |
| `@prospero/core` | messages、state machine、system policy、loop、permission semantics、limits、completion/failure/cancel | Electron、React、provider protocol、Node I/O、DB |
| `@prospero/providers` | fetch、OpenAI wire mapping、bounded SSE parser、connection test、安全错误 | agent policy、tool execution、persistence |
| `@prospero/tools` | host-neutral tool metadata、JSON schemas、strict argument checks、limits | Node/Electron I/O |
| `@prospero/local-host` | 文件边界、完整 diff、写入验证、进程环境/执行/清理 | React、renderer |
| `@prospero/persistence` | SQLite schema/version migration、snapshots、execution summaries、encrypted credential blobs | provider、React、Electron |
| `apps/desktop` main | composition、credential encryption、native window/menu/dialog/clipboard/notification、IPC、session grants、durability | renderer runtime |
| `apps/desktop` renderer | tokens、timeline、diff、settings、composer、domain UI store | privileged Node/environment APIs |

Package exports 指向 TypeScript 源码；esbuild 将生产 main/preload 打成 CJS。Main 除 Electron、Node built-ins 外无运行时外部 npm 依赖。Vite 只构建 renderer，生产窗口加载 `dist/renderer/index.html`。

## Execution

`idle → planning → model-request → waiting-permission/tool-running → model-continuation → ... → completed/failed/cancelled`。

Core 固定 system policy，把 saved memory 标记为低优先级数据。模型返回 assistant/tool_calls；host 严格验证参数并 prepare preview；core 按 risk/host policy 调用 PermissionPort；批准后 host execute；结果作为 tool message 进入下一 model turn。Deny/prepare/tool failure 也产生明确的 error result。并列 tool calls 依次执行。

Core 默认限制为 12 model turns、32 tool calls、180 秒 active execution、300 秒单次审批等待和 900 秒 wall clock；审批等待不消耗 active execution。Desktop 显式采用 24 turns、64 tool calls、600 秒 active / 300 秒 approval / 1800 秒 wall clock。启动时的主进程凭据与 scope 初始化另限 30 秒，并从任务总 wall clock 扣除；Stop 可停止等待 OS 回答，晚到结果不再修改 scopes、重新加密凭据或启动模型。不能物理取消已显示的系统凭据弹窗。

`Stop` 将 AbortSignal 传给 provider、permission wait 和 host。Core 取消模型/审批等待及时返回，但工具 execute 必须先完成清理再返回。剩余未执行的 tool calls 都补齐 interrupted/cancelled results，保证再次发给 provider 的 history 配对有效。192 KiB serialized ModelRequest 预算通过 core-owned execution-only 滚动摘要限制；完整历史仍保存，摘要不进入 renderer/SQLite，provider wire contract 保持不变。

## Bounded research

`@prospero/web` 的 `WebClient.search/fetchPage` 同时支持 Brave 与 Tavily，core 和研究授权契约保持不变。main 根据保存的显式 provider 选择 adapter 及独立 endpoint-bound credential；旧设置缺 provider 时默认 Brave。Tavily 使用固定搜索 endpoint 的 bounded POST，页面继续共用无 credential 的安全 GET。Test Connection 的 draft provider 不修改设置或来源。

`authorize_research` 只产生 main-generated、frozen、digest-bound 预览，列出确切查询、结果上限、search/fetch 次数、累计 response body bytes 和到期时间。一次批准之后，main 私有的 `ResearchAuthorization` 逐次预留、核验并消费 opaque request reservation；`web_search` 只能使用清单内查询，`fetch_source` 只接受这些成功搜索实际返回的 source ID。`fetch_page` 不能作为扩大范围的替代。一次批准本身不代表已经联网。

Core 对 network effects 仍强制调用 PermissionPort。Main 仅对当前 host 中同一 prepared call/preview/permission key 自动返回 allow-once，剩余网络操作走原审批路径；没有通用 network allow-session。拒绝阻断本次 run 的所有 web fallback，重启只恢复审计数据，不恢复执行授权。决策、预留与 dispatch 审计先同步保存 conversation snapshot，再产生请求效果。详细契约见 [ADR-007](decisions/ADR-007-bounded-research.md)。

## Durability and concurrency

SQLite WAL 保存 conversations/messages/timeline、provider metadata、settings、workspace/files 和 execution summaries。每个离散事件保存快照；stream deltas 以 32 ms batch 发往 renderer，不逐 token 落盘。已完成或主动 Stop 的部分文本持久化；硬崩溃时当前未落盘 token 可能丢失，已保存历史仍保留。

启动时所有非终态 executions 标为 interrupted，不自动继续工具。DesktopService 同时只保留一个 active task；provider save/test 独占该 provider，防止 endpoint/credential mismatch。single-instance lock 防止两个窗口主机同时操作默认 profile。不同 isolated test profiles 可独立启动。

凭据明文仅在 main 内使用；加密 envelope 同时包含 provider id 与规范化 endpoint。每次读取必须匹配 main 当前期望的绑定，避免密钥已保存、provider metadata 保存失败后把新密钥交给旧 endpoint。旧格式密文首次成功读取时，在相同 reservation 内迁移；这依赖原来保存的 endpoint，不能追溯证明旧格式的历史绑定。

配置与模型连接测试的逻辑等待最多 30 秒，Web Search probe 最多 15 秒。取消/超时后立即停止业务等待，但 provider/Web reservation 保留到实际 native promise settle；晚到 availability/encrypt/decrypt/re-encrypt 不能写 SQLite 或发起请求。窗口关闭和 quit 同步拒绝新配置/测试/任务，随后取消逻辑等待；Dock 重开显式恢复入口。此处不承诺物理取消 Keychain 弹窗或 native worker。

任务中断、失败或计划部分完成时，main 根据实际工具与 journal 生成已完成/未完成报告，不再请求模型猜测结果。重启的 action 只按已保存 journal 标记 confirmed、needs-inspection 或 not-completed，不自动重放。给模型的恢复摘要限 24 KiB JSON，source metadata catalog 限 32 KiB JSON，均保留记录省略计数；完整审计与 UI 数据不截断，保留的 metadata 不能恢复权限或来源抓取 authority。

## UI state

Renderer shell 持有 bootstrap metadata；conversation domain store 使用 `useSyncExternalStore`，合并 stream snapshots，并保留未改变 timeline item 身份。独立的 renderer 内存 draft store 保留切换任务时的草稿，并在 attachment-driven conversation 创建时转移欢迎页输入；草稿不进入 model context，不跨 App 重启保存。Tool output 有显示与模型双层上限；不展示 private chain-of-thought。审批卡展示可观察的 command/path/diff/status。无效或无法准备的工具请求也有固定安全标题的失败记录。

## Native desktop host

Electron main 管理 macOS window lifecycle。`hiddenInset` titlebar 保留系统 traffic lights；renderer 留出 safe area，限定 drag region 并排除交互控件。窗口支持 minimum size、resize、fullscreen、minimize/restore 与 native Zoom；启用 macOS trackpad scroll bounce。Sidebar vibrancy 跟随窗口，Reduce Transparency 开启时移除；内容主区域保持不透明和可读。

`main/menu.ts` 构建 Prospero/File/Edit/View/Window/Help，使用 native Edit/Window roles。Cmd+N/K/,/F/\ 与 Cmd+Shift+P 发出 typed `desktop-action` events；fullscreen 显式绑定 Ctrl+Cmd+F。Reload 仅 local development HMR 提供。重开窗口后的 native action 等待 renderer 通过 validated、零参数 `ready` 确认，避免初始化期间丢失命令。

最后窗口关闭时，先同步禁止新 task startup，abort active runs 并等待清理，再销毁窗口。macOS 保留空闲 App process。Dock activate 和 second instance 在 close cleanup 后重开唯一主窗口，并合并并发创建。Cmd+Q 经过 `before-quit` cleanup 后关闭 SQLite 并退出。关闭和重开都不会自动恢复 interrupted tool。

保存的 theme 控制 `nativeTheme.themeSource`；bootstrap 和 `desktop-appearance` events 提供 dark appearance 与 native Reduce Motion。Main 监听 native theme update 与 macOS accessibility display-options notification，不使用 polling；renderer 同时尊重 CSS media preferences。

Context menus 是 native Electron menus，使用 typed conversation/message/file targets。Main 提供 Rename/Delete confirmation actions，从保存的 message 读取 Copy 内容，并在 Reveal in Finder/Copy Path 前复核 workspace/attachment/known preview path。系统 clipboard 写入有大小限制且等待完成；renderer 没有 clipboard read API。持续至少 10 秒的任务完成时，窗口失焦才发送 silent、generic native notification，不含任务文本或路径。

Visual tokens、soft surfaces、progressive disclosure 与 accessibility 约定见 [macOS-native UI](MACOS-NATIVE-UI.md)。
