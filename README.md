# Prospero

Prospero 是一个运行在本机的 desktop personal agent。它能持续对话、拆解任务、读取本地资料，并在你批准后修改文件或运行命令。它是独立的个人 Agent 产品；Ariel 是另一个 coding agent 项目。

![Prospero desktop task timeline](docs/screenshots/conversation-dark.png)

## Features

- OpenAI-compatible Chat Completions：自定义 endpoint、model、streaming 与 tool calling。
- 真实多轮 Agent loop：工具结果回到模型，直到完成、失败、取消或达到限额。
- 本地 conversations、task timeline、workspace、settings 和显式 Memory。
- 本地工具 `read_file`、`list_directory`、`get_file_info`、`search_files`、`write_file`、`shell`、`execute_plan`；研究工具 `authorize_research`、`web_search`、`fetch_page`、`fetch_source`。
- 明确的多根 read/write 文件范围；普通文件复制、移动、重命名、建目录、文本写入及窄 macOS actions，使用不可变 Action Plan 一次批量审批与逐动作 durable journal。
- 独立 `@prospero/web`：Brave Search / Tavily、公开 HTTPS 正文提取、来源指纹与 citations；默认关闭，单次请求或不可变研究范围均须 main 批准。两种搜索凭据分别存入 safeStorage。
- 写入前完整 unified diff；每条 shell 命令均显示 cwd 并独立审批。
- Stop 取消模型请求、授权等待和工具执行，并等待 shell 进程组清理。
- 面向 macOS 的 unified titlebar、系统 traffic lights、原生菜单与右键菜单；柔和无框线的 warm surfaces、floating composer 和工具 timeline。
- Light / Dark / System、实时系统 appearance、Reduce Motion、原生文件选择器与可折叠侧栏。

## Quick Start

在 macOS Apple Silicon 上已验证 Bun 1.4.2、Node 24 与 Electron 44.5.1。Bun 用于安装、开发脚本与测试，Node 24 用于桌面 E2E runner。生产 App 自带 Electron runtime，无需系统 Electron 或 Rust。

```sh
git clone https://github.com/pollackcarlos21-create/prospero.git
cd prospero
bun install --frozen-lockfile
bun run dev
```

开发模式 Vite 仅负责资源/HMR。生产产品通过 Electron 加载本地构建文件，不需要 localhost server。

生产启动和打包：

```sh
bun run build
bun run start
bun run package
```

应用生成于 `release/Prospero-darwin-arm64/Prospero.app`。打包会完成本地 ad-hoc 签名并验证完整 bundle，用于本机开发和原生通知；这是未进行 Developer ID 签名或 notarization 的 development build，请按本机策略运行。

## Configure OpenAI-Compatible API

打开 Settings → Models → Add provider，填写 Name、Base URL、API key 和 Model，先 Test connection 再 Save provider。

```text
Name: My provider
Base URL: https://api.example.com/v1
Model: example-model
API key: stored securely, never displayed again
```

支持 `/v1` API root 或例如 `https://api.deepseek.com` 的 root endpoint；不会自行添加 `/v1`。HTTPS 可使用任意兼容服务；无认证本地服务可用 loopback HTTP/HTTPS，并留空 key。其他远程 HTTP 被拒绝。更改已保存 key 的 endpoint 时需要重新输入 key，避免把凭据发送给另一服务。

DeepSeek 首次配置可使用 Base URL `https://api.deepseek.com`、Model `deepseek-flash`，并保留 tool calling。对官方 endpoint 的 `deepseek-flash` / `deepseek-v4-pro`，当前 adapter 明确使用非 thinking 模式，以符合现有多轮工具协议；真实服务兼容性须另作有限试用。依据及范围见 [Provider compatibility](docs/PROVIDER-COMPATIBILITY.md#deepseek-current-models)。

Test connection 首先调用 `GET /models`；404/405/501 或成功响应不符合 models JSON 格式时，回退到最多一个输出 token 的 Chat Completions 检测。认证错误不会触发回退。详细协议范围见 [Provider compatibility](docs/PROVIDER-COMPATIBILITY.md)。

## Configure Web Search

联网研究需要两项独立配置：支持 tool calling 的 model provider，以及 Brave Search 或 Tavily API key。在 Models 中保留 `This model supports tool calling`，然后：

1. 打开 Settings → Web Search，通过 Search provider 选择 Brave Search 或 Tavily，填写该供应商的 Search API key，勾选 Enable Web Search。Tavily key 不能用于 Brave；两者分别保存，不互相回退。
2. 点击 Test search connection。成功应显示 Connected to Brave Search 或 Connected to Tavily；该操作只检测搜索连接，发送一次固定查询，可能使用搜索额度，不保存设置。
3. 点击 Save Web Search；看到保存成功后关闭 Settings。模型 key 和搜索 key 各自安全保存，不能互相替代。
4. 创建任务并选中 model provider。聊天中的 Web Search 状态可直接打开对应设置；模型关闭 tool calling 时会提示先在 Models 中启用。配置可用不代表已经发出联网请求。例如输入：`请实际联网查阅 Electron 官方文档，读取相关网页，说明 macOS 支持范围并附来源链接。`
5. 搜索后需要读取网页时，即使只有一个查询，也优先审阅一次 Research scope：批准确切查询、搜索结果数量、网页读取次数、字节和有效期，随后搜索并读取实际返回的来源。结果应包含实际来源引用，Sources 中能区分搜索片段与已读取页面；单凭模型文字不能证明搜索或抓取成功。独立查询和直接网页读取仍各自审批。

纯联网研究不需要授权本地文件夹。Test search connection 成功只证明搜索连接，还需完成实际模型调用、查询审批、网页读取和来源展示，才算本次研究闭环通过。此流程会向所选模型服务、所选搜索供应商及获准的公开网页发送请求；离线测试不证明这些真实服务当前可达。Tavily 使用 basic 搜索，不启用其生成式 answer、raw_content、Extract 或 Crawl；搜索摘要与独立抓取页面分别记录。

Test search connection 会区分本地安全存储失败与所选供应商的认证或网络失败：提示解锁 OS credential store 时，尚未发出搜索请求；提示搜索连接超时时，则需要检查联网状态。研究范围过期或预算耗尽后会显示明确原因，继续研究须在新任务中重新批准。

当前本地签名包已通过模型 key 与 Brave 搜索 key 的原生加密保存、任务读取及重启读取回归，使用独立临时 profile 和 synthetic keys，没有调用真实搜索服务。历史包曾出现首次 macOS 凭据检查超时；跨安装、重签和不同 OS 授权状态的稳定性仍待验证。当前结果与失败边界见 [v1 验证记录](docs/V1-VALIDATION.md)。

## First task

1. 点击 New task，选择 model provider。
2. Attach workspace 选择主要工作文件夹；File scopes 可添加 read 或 writable 文件夹，Attach files 可授权单个只读文件。范围变更须先停止任务。
3. 输入任务，点击 Send 或 Cmd+Enter。
4. 读取/list/search 默认自动允许，但受文件工具边界限制；可在 Permissions 开启读取审批。
5. 对 Action Plan 检查所有动作、路径、效果和文本 diff，再一次 Allow plan 或 Deny。多查询研究可先批准 Research scope 的确切查询、次数、字节和有效期，之后只访问实际搜索来源；每条 shell 与范围外的单次网络操作仍独立批准。拒绝研究后本次任务不能换查询或工具绕过；拒绝或部分失败后也不能自动尝试其他 mutation。
6. Stop 或 Esc 停止运行；重启后可继续已保存对话，中断任务不会自动重跑。

## macOS interaction

窗口采用 `hiddenInset` titlebar，保留系统 traffic lights、resize、fullscreen、minimize 与 Zoom；交互控件不属于 drag region。菜单栏提供 Prospero、File、Edit、View、Window、Help，Undo/Redo、Cut/Copy/Paste、Select All 使用系统行为。Reload 仅开发 HMR 模式提供。

| Shortcut | Action |
| --- | --- |
| Cmd+N | New Task |
| Cmd+K / Cmd+Shift+P | Command Palette |
| Cmd+, | Settings |
| Cmd+F | Search Tasks |
| Cmd+\ | Toggle Sidebar |
| Cmd+Enter | Send |
| Cmd+W | Close Window |
| Ctrl+Cmd+F | Fullscreen |
| Cmd+Q | Quit Prospero |
| Esc | Close the current sheet/palette, or Stop the active task |

关闭最后一个窗口会先停止任务并等待工具清理，然后让 App 保留为空闲进程；不会在无窗口时继续或自动开始 Agent 工作。点击 Dock icon 或再次启动会重开主窗口。Cmd+Q 等待清理后真正退出。

任务右键支持 Rename/Delete，消息右键使用系统 clipboard Copy，已授权 workspace/file 右键支持 Reveal in Finder/Copy Path。删除通过 confirmation sheet 再次确认。完成持续至少 10 秒的任务时，仅在窗口失焦情况下发送安静的 macOS native notification；通知不包含任务内容或文件路径。

默认跟随 System theme，Light/Dark 可独立选择；native chrome 同步对应 appearance。实时 Reduce Motion 关闭较大动画，Reduce Transparency 关闭 native sidebar vibrancy。完整 surface、accessibility 与交互约定见 [macOS-native UI](docs/MACOS-NATIVE-UI.md)。

## Security model and permissions

Renderer 使用 sandbox、context isolation，禁用 Node integration；只有明确列举的 IPC API 可访问主进程。Native context menu 的目标与内容由 main 重新验证；clipboard API 仅提供有大小限制的写入，不提供读取、任意 Finder path、URL launcher 或通用命令。API key 输入时短暂存在于 password field，之后不会从主进程回传。密文保存在 SQLite，由 Electron async safeStorage 使用 macOS Keychain 管理加密 key。安全凭据服务不可用时拒绝保存，不退回明文。

文件工具拒绝 traversal、未授权范围和 symlink，并核对已选根的身份与预览内容指纹；只读范围不能写入，单独 attachments 仅授权精确文件读取。**shell 具有当前 OS 用户权限，cwd 不是 OS sandbox**；每条命令均须确认，环境不会继承 provider secrets。读权限的 Allow for this session 仅限当前 conversation 的相同 workspace/attachment scope；退出或换 workspace 后清除。保存设置清除后续任务的 session 复用；当前任务仍保留已批准 scope，结束它请用 Stop。改变读取审批 policy 前须先停止任务。写入和 shell 不提供 session 自动授权。

本地 conversation、文件预览、非 Web 工具输出、Action Plan/journal 与 Memory 以明文存在 SQLite，受用户目录访问权限保护。Web 原始正文仅用于当前模型执行，不落 SQLite 或 renderer IPC；来源 metadata/excerpt 默认保留七天，也可选择仅当前 App session。用户/Agent 会话文本以及搜索 query、请求 URL 的审核记录仍按会话保留；保留策略不承诺清除会话中由用户或模型引用的文字。模型 provider 会收到当前对话、显式 Memory、工具定义及结果；选择 provider 意味着这些上下文会发往该服务。详见 [Security](docs/SECURITY.md)。

## Development

```sh
bun run typecheck
bun run lint
bun run format:check
bun test
bun run test:acceptance
bun run security:audit
bun run build
bun run test:e2e
```

E2E 使用本地 fake OpenAI-compatible server，启动真实 Electron，保留全部 v0.1 回归并验证多根文件组织、批量审批、deny/stale/partial、Stop/restart、Web research 和 adversarial prompt injection。Web E2E 通过仅测试入口替换 DNS/HTTPS I/O，加载相同生产 main/preload/renderer；不调用真实 Brave / Tavily，也不代表真实 TLS 握手已验收。无需真实 API credential 或额外浏览器安装。见 [Development](docs/DEVELOPMENT.md)、[Architecture](docs/ARCHITECTURE.md)、[ADRs](docs/DECISIONS.md)、[本次验证记录](docs/VALIDATION.md) 和 [v0.1 交付报告](docs/IMPLEMENTATION-RESULT.md)。v0.2 的实现与本次验收分别见 [实施说明](docs/V02-IMPLEMENTATION.md) 与 [验收记录](docs/V02-VALIDATION.md)。

## Current limitations

2026-10-06 用户亲自试用，确认联网可用并接受本轮交付，当前版本为 0.2.0。后续正式 v1.0 的固定任务验收集见 [V1-ACCEPTANCE](docs/V1-ACCEPTANCE.md)，当前增量验证见 [V1-VALIDATION](docs/V1-VALIDATION.md)，真实任务验证方案见 [V1-REAL-VALIDATION](docs/V1-REAL-VALIDATION.md)。人工联网验收不计为完整 30 项真实验证成绩。

`test:acceptance` 在临时目录中逐项执行固定 30 个任务，使用真实 DesktopService/provider/parser/SQLite/文件 host 与明确标注的 fake model/Web/vault/native ports。它独立检查文件、实际来源正文指纹、批准、逐项 journal 和恢复结果，输出 `output/v1-acceptance/offline-tasks.json`；这是任务层离线集成验收，真实模型完成率和真实 TLS/macOS Trash 另行验证。Stop/partial/crash 后显示 main 生成的结果清单；新任务获得有字节上限的恢复事实，历史批准不会恢复。

`test:live-dry-run` 仅在当前完整离线任务报告和 bundle 指纹匹配时检查真实验收准备：默认无授权的 30 项请求全部拒绝，0 外部 HTTP、不读取密钥、不执行 native 操作。预算 SQLite journal、精确快照匹配及 provider/Web 计量接缝已用离线端口验证；连接探测、任务/摘要及批准后的研究经过相同服务入口。完整真实 runner、独立语义审查、真实端口/native 验证和具体 human 授权仍待完成，不能把这些准备模块计作真实成功。

Web Search settings 的 Test search connection 可检测待保存或已保存的 Brave / Tavily key：只发送一次固定查询，不保存设置或来源，可能消耗搜索额度。启动任务的凭据初始化最长 30 秒，Stop 不等待系统回答，晚到响应不再启动任务。打包可设置 `PROSPERO_ELECTRON_ZIP_DIR` 指向已有匹配版本的 Electron ZIP 目录；此路径让 packager 完全关闭下载器。

- macOS arm64 为本次验证目标；未验证 Windows/Linux packaging。
- 当前 App 一次只执行一个 task。模型输入超过 192 KiB core request 预算时，较早的完整消息组会生成 execution-only 摘要；最新用户请求和最新完整工具组保持原文，完整会话继续保留。摘要不授予权限、不持久化、不在 renderer 展示，且额外调用消耗 turn/time 预算。不可压缩的超大输入安全停止；字节预算不等于所有 provider 的 token context limit，真实摘要保真仍待验证。
- 只支持标准 streaming Chat Completions/tool_calls；无 custom headers、legacy function_call 或 Responses API。
- structured copy/move/rename 只处理不超过 32 MiB 的普通文件，不覆盖现有目标；文本写入限 256 KiB，展示完整 diff。目录非递归复制/删除；Trash 走原生 adapter。批次逐项执行，不是跨文件原子事务，也不回滚已完成效果。
- 文件信息使用 filesystem modifiedAt/createdAt，不宣称它们是下载时间。目录最多扫描 20,000 entries；输出为带 nextCursor 的完整 JSON，目录变化后必须重新列举。批次最多 25 actions，累计保留内容和 copy/move/write 字节分别限 128 MiB。
- Desktop task 限 24 model turns / 64 tool calls / 10 分钟 active execution；单次审批等待限 5 分钟，总 elapsed time 限 30 分钟。等待审批不消耗 active execution，但不会无限挂起。达到任何预算后停止，继续需要新任务。
- shell 是显式批准的完整用户命令；清理覆盖同一 POSIX process group。主动 daemonize/另建 group 的进程，以及 SIGKILL、断电或 OS main-process crash 后的子进程不在保证内。
- browser computer-use、连接器、MCP/plugins、后台任务、vector memory、多 Agent、Tempest 和 SwiftUI 均延期。Web 仅支持公开 HTTPS HTML，不登录、上传、执行网页脚本或下载附件。
- 未运行真实 provider smoke 时，不能把 fake-server 测试视作所有真实服务已兼容。

## License

MIT。见 [LICENSE](LICENSE)。
