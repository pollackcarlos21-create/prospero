# Security

本篇说明保留的 Electron/provider/legacy tool 边界。v0.2 的 effects、多根 scopes、不可变 Action Plan、journal、Web 和差异化 retention 详见 [V02-IMPLEMENTATION](V02-IMPLEMENTATION.md)。

## Trust boundary

主进程拥有 privileged host。Renderer 设定 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 和 `webSecurity: true`。Preload 只暴露固定业务方法，没有通用 invoke/eval/fs/shell API。Main 校验 sender window、main frame、精确 URL、参数数量、类型、字段 allowlist 和大小；renderer navigation/new windows/webviews/downloads/OS permission requests 默认拒绝。生产 CSP 禁止 renderer network 和 remote scripts。

## Credentials

生产 GUI 输入 key 后，主进程使用 Electron asynchronous safeStorage。macOS 加密 key 由 Keychain 管理，SQLite 仅保存 ciphertext；Renderer 只收到 hasApiKey。安全 OS 服务不可用时拒绝保存，Linux basic fallback 被拒绝。修改 endpoint 不能复用旧 stored key；测试连接也受该绑定限制。save/test provider 期间拒绝同 provider 并发修改、删除或 task startup。开发环境 fallback 仅绑定 PROSPERO_BASE_URL，packaged app 禁用。

OS 加密的 envelope 绑定 provider id 与规范化 endpoint；读取时按 main 当前配置复验。即使新密文写入后 provider metadata 保存失败，旧 endpoint 也不能获得该 key，重启后仍 fail closed 并要求重新输入。旧格式首次成功解密时按已有 endpoint 迁移，无法追溯验证迁移前的绑定；不使用仅内存 quarantine 或 best-effort rollback 作为安全保证。

凭据配置/模型 probe 的逻辑 deadline 为 30 秒，Web Search probe 为 15 秒。关闭窗口/quit 取消逻辑等待并拒绝新操作；相同 provider/Web reservation 保留到实际 native promise settle。每个 async native 返回后检查 abort，取消或超时后不保存 ciphertext/config、不发出晚到 HTTP。系统弹窗或 native worker 不能保证物理取消；该逻辑保证不等于冷启动 Keychain 可用性或退出时间保证。

Provider 的 error body、raw fetch errors、Authorization 和 API key 不出现在 UI/log。成功 SSE 中精确反射已配置 key 时进行跨 chunk redaction；包含该 key 的 tool requests 会拒绝，以免改变命令含义。自定义其他私密内容不会自动识别；conversation 用户内容/获批文件结果不是通用 secret detector 的替代品。

[Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage) 说明 macOS 使用 Keychain，稳定签名身份有助于避免更新时重新请求权限。此版本未进行发布签名/notarization。

## Permissions

Read/list/search 默认限于已选的 workspace 或明确 read/write scopes；省略 scopeId 的 legacy 参数仍以 workspace/精确 attachments 为准。可启用逐次 read confirmation；允许 session 时是该 conversation 的整个 workspace read scope，精确 attachments 独立授权。session grants 不持久化，scope 含 root/file identity，换 workspace 和重启后清除。保存设置清除后续任务的 session 复用，但当前 run 保留已批准的 scope；Stop 结束当前 run 的授权。改变读取 policy 前必须停止 active task。

Write/shell 和所有 `file.read` 以外的 effects 必须确认，不接受 session bypass。structured actions 使用一次精确 digest-bound 批量审批，deny/stale/partial/failed/cancelled 后本次 run 不能换用 legacy write/shell/native 继续 mutation。Write prepare 生成完整的受限 unified diff；超过 32 KiB 或复杂度上限拒绝准备。UI 展示全部已接受 patch；approval 后再次验证文件内容 hash、inode/metadata、路径链和 symlink/hardlink 状态，不接受 stale preview。

## Filesystem and shell

Filesystem tool arguments 严格 schema 校验；拒绝 traversal、absolute escape 和 symlink 路径链；attachments 只授权 exact-file read。读写使用 O_NOFOLLOW、路径 identity 检查及 bounded I/O；legacy write 要求已有父目录；structured create_directory 可在已批准的计划内创建并作为后续依赖，不提供任意目录树递归删除。此 capability boundary 不是面向恶意本地 OS 用户/进程的内核 sandbox，不能保证原子阻止所有 hostile concurrent path replacement。

Shell cwd 必须是选中 workspace，env 仅含受控 PATH、HOME 等必要值，不继承 provider credentials、NODE_OPTIONS 或 shell startup 环境。Shell **具有完整 OS 用户权限**，命令可以通过绝对路径访问 workspace 外；每条命令必须用户批准，cwd 不构成 sandbox。超时/Stop/最后窗口关闭/正常 App quit/renderer crash/可处理 main exception 会等待 POSIX process-group TERM/KILL 清理，包括仍处于该 group 内的 background children。主动 daemonize、setsid 或另建 process group 的进程不在保证内。断电/SIGKILL/无法运行清理的 OS crash 也不保证清理。

## Native integration

Native menu/keyboard command 使用固定 `desktop-action` event union。Renderer `ready` acknowledgement 只确认当前窗口就绪，不能提交任意 menu role、privileged command 或 IPC channel。App 保留一个主窗口；关闭时同步禁止 task startup，abort 并等待清理后销毁，空闲 macOS process 不继续 Agent 工作。Dock/second-instance 重开恢复显式交互，不恢复执行。Cmd+Q 等待清理后关闭数据库并退出。

`showContextMenu` 接受精确的 conversation/message/file target schema。Rename 是有长度限制的持久化 title 修改；Delete 打开 confirmation sheet，active task 期间不可使用。Message Copy 使用 main 保存的 user/assistant content，不接受 renderer 替换内容。File actions 仅接受精确 workspace、精确 attachments，以及 workspace 内已知 preview paths。准备菜单和执行动作时都验证 absolute/path scope 与所有现存 symlink components，拒绝已改变或无关路径。这是受限 Reveal/Copy capability，不提供通用 Finder、filesystem 或 URL launcher。

`copyText` 只写，拒绝 NUL 和超过 256,000 characters 的输入，并等待 Electron native system clipboard write。没有 renderer clipboard read method。Native menu 捕获 host-operation failure，不显示 raw details；此 capability 不保存或记录 clipboard content。

持续至少 10 秒的成功任务仅在窗口失焦时发送 silent native notification；内容只有通用完成提示，不包含 user task、model response、file path 或 credential。关闭窗口取消任务并抑制此完成路径。OS policy 与 notification support 决定实际 delivery。

System appearance 与 accessibility changes 使用 native APIs 和固定 events，不调用 shell 或修改 macOS 全局设置。交互与 accessibility contract 见 [macOS-native UI](MACOS-NATIVE-UI.md)。

## Local data and diagnostics

Conversation/messages、tool output、diff previews、Memory 都以明文保存在本机 SQLite；目录/数据库/log 使用限制性权限。文件内容和当前上下文会发送给用户选定的 provider；没有后台自动上传、隐藏 memory extraction 或 cloud sync。日志只接受固定 event code 和有限标量 metadata，不记录 conversation、file、request、error body 或 secret。

## Reporting

项目暂未配置公开 remote；请在 Chief Architect review 中以最小复现报告安全问题，不要附真实凭据。跨端代码应先重新验证 OS credential provider、Electron runtime 和 shell termination semantics。

## v0.2 Web 与 retention

公开 fetch 采用 URL + 全部 DNS answers 验证、地址 pin、逐跳验证、TLS certificate/remote-address checks、固定无 credential/cookie 的 page headers 与累计大小/deadline 限制。Web package 没有文件/shell/SQLite port；页面文本始终是 untrusted data，不能授予权限或 scopes。Brave token 和 Tavily Bearer 分别只用于各自固定搜索 endpoint，搜索不跟随 redirect。Tavily POST 的 JSON request body 限 16 KiB；页面 GET 没有 body 或搜索认证。两种 key 分别保存和绑定，切换、删除或测试一个供应商不会使用另一供应商的 key。每次网络请求在执行侧消费一次批准；受控研究通过一次 digest-bound exact-query scope 提供逐请求 main-owned allow-once，core 仍强制调用 PermissionPort，不提供 network session grant。

研究范围、次数、原始 response body byte cap 与有效期不可由网页扩大。后续 fetch 只接受本 scope 实际成功搜索的 source ID；prepared opaque reservation 必须在 execute 前再次验证并消费 dispatch latch，决策/预留/dispatch 审计先持久化再产生效果。任意 web denial 阻断本次 run 的其他 web tool、替代查询和重新授权。真实网络完成后的 audit failure 不能撤销已发请求，但不会返回可用 source authority；未知 partial failure 按全部预留 body 额度记账。cap 不含 TCP/TLS/HTTP headers，不保证远端收费语义。重启恢复审计数据，不恢复 grant。

凭据读取与 scope 初始化有限时，Stop 可结束等待；SecureCredentialVault 在异步 OS 返回后检查 abort，晚到解密不会重新加密、保存或启动任务。不能保证取消 OS 弹窗本身。任务初始化、配置保存和 stored-key probe 都占用其 reservation 直到实际原生 promise settle，逻辑取消不会允许 endpoint 在旧解密仍进行时重绑。Web Search Test Connection 使用一条固定查询和 15 秒包含 vault 的 deadline，返回固定状态，不保存设置/来源/body，不提供任意 endpoint/query RPC。

raw Web tool body 仅本次模型执行可见，随后 main 内存 timeline/messages、renderer IPC 与 durable conversation 都替换为固定说明；metadata/excerpt 仅独立 SourceRecord 表七天或当前 app session。会话中用户/Agent 自行引用的文字以及 query/URL audit 仍随 conversation 保存；Source TTL 不是通用会话擦除或 forensic erase。
