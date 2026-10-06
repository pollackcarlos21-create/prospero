# PROSPERO V0.1 DESKTOP AGENT USER-READY IMPLEMENTATION RESULT

Prospero v0.1 已在本机实现并完成 macOS arm64 开发打包；最终 signed 包验收尚未全绿。macOS 系统级人工验收尚未全部完成；真实 System appearance/Reduce Motion 已操作并恢复原设置，native Cmd+Q 与 native menu Quit 修复后均实际退出成功。完整本地 ad-hoc packaging 已通过；最终 signed 包首轮 5 passed / 1 failed 停于 OS Keychain 交接；用户现已确认授权，plain credential Save / Cmd+Q 成功，最新 signed 包 E2E 已结束，为 5 passed / 1 failed / 49.2s；新进程的安全保存交接仍未通过。源码位于 `/Users/chadrayfoo/Projects/prospero`，保持未暂存、未提交、未推送；最终批准等待 Chief Architect review。

快速运行：打开 `release/Prospero-darwin-arm64/Prospero.app`，进入 Settings → Models 配置自己的 API，再创建 task。开发入口为 `bun install --frozen-lockfile` 和 `bun run dev`。完整证据见 [VALIDATION.md](VALIDATION.md)。

## Start State

目标目录最初不存在，已新建独立 Git repo。环境为 macOS arm64、Bun 1.4.2、Node 24.14.0、Git 2.55.0；没有安装系统软件，没有修改 Ariel 或 chat 原始目录。

## Product

可配置 provider、持续 streaming 对话、执行本地多步 task、批准写入/命令、中途 Stop、保存并重启继续的 desktop personal agent。版本 `0.1.0`，MIT license。

## Architecture

Electron main 负责 composition；core、provider、tool metadata、local host、persistence 分离。core 不依赖 Electron、React、Node I/O 或 provider 协议。没有提前提取 Tempest。

## Desktop Stack

TypeScript + Bun workspaces + Electron 44.5.1 + React 19.3.0 + Vite 8.3.2；esbuild 构建 main/preload，SQLite 使用 Electron 自带 Node 的 `node:sqlite`。

## Repository Structure

```text
apps/desktop/       main, preload, typed IPC, React UI
packages/core/      execution semantics and ports
packages/providers/ OpenAI-compatible fetch/SSE
packages/tools/     tool metadata and strict schemas
packages/local-host/filesystem and shell adapters
packages/persistence/SQLite store and migrations
tests/e2e/          local fake server + real Electron tests
scripts/            dev/build/package/smoke/security audit
docs/               architecture, security, ADRs, evidence
```

## Electron Security Boundary

启用 context isolation、sandbox、webSecurity，禁用 Node integration。固定 preload 方法和主进程 sender/frame/URL/参数校验；生产 CSP 禁止 renderer network。禁止额外导航、窗口、webview、下载和未经许可的 OS 权限请求。

## UI / UX

完成 macOS unified titlebar、系统 traffic lights、六个原生菜单、原生右键菜单与文件选择器。采用 warm ivory/graphite、无可见框线、统一圆角、floating composer、flow timeline、soft diff 和按需 palette/settings/permission sheet。Cmd 系列快捷键、focus trap/restore、System appearance 和 Reduce Motion 已实现；[macOS 验收矩阵](MACOS-NATIVE-UI.md) 区分实际操作、E2E 与尚未人工验证的项目。stream updates 批量呈现，切换 task 保留内存草稿。

## Provider System

支持多个 provider 的创建、编辑、选择、删除与连接测试。请求和凭据仅在 main；已保存 key 与 endpoint 绑定，并对 provider mutation/test/执行并发加锁。

## OpenAI-Compatible API

支持标准 Chat Completions，任意兼容 HTTPS API root，不自动补 `/v1`。HTTP 仅 loopback；本地无认证可省略 key。Test Connection 先 `/models`，404/405/501 或成功格式不兼容时最多一 token 回退；401/403 不回退。

## Streaming

增量 SSE/UTF-8 text、tool-call deltas、finish reason 与可选 usage。Stop/timeout 取消请求；安全处理非法协议和错误，不展示私有 reasoning。已配置 key 的精确反射进行跨 chunk redaction。

## Agent Loop

真实 model → tool prepare → permission → execute → result → model continuation。顺序执行 tool calls；默认 12 model turns、32 tool calls、180 秒总限额。deny/failure/停止均保留配对 tool history；无效工具也有安全失败卡片。

## Tools

实现 `read_file`、`list_directory`、`search_files`、`write_file`、`shell`。strict arguments、输出限额、真实 temp 文件与实际进程回归验证；获批结果进入下一模型轮次。

## Permissions

支持 Allow once、只读 Allow for this session、Deny。write/shell 每次独立批准。read session 绑定 conversation 和 workspace/精确 attachment identity；不持久化。保存设置清除后续 task 的复用；当前 run 的 scope 由 Stop 结束。

## Workspace / Filesystem

原生 workspace/file picker。文件工具拒绝 traversal、symlink 和 absolute escape；外部 attachment 只读。写入前完整 diff，批准后再次验证 hash/identity/path，拒绝 stale preview。文件能力边界不是 OS 内核 sandbox。

## Shell Execution

审批显示 command、cwd 和完整用户权限。受控 PATH/HOME，stdout/stderr/exit code、32 KiB 输出限额，默认 15 秒/最多 120 秒。Stop/timeout/正常退出等待同一 POSIX process group 的 TERM/KILL 清理；主动 daemonize/另建 group 不在保证内。

## Persistence

SQLite WAL + schema version/migration 保存 conversations、messages、timeline、provider metadata、settings、workspace、attachments、execution summaries 和凭据密文。重启修复 interrupted 状态，不自动重跑工具。

## Memory

显式 editable Memory 页面，支持增删改；作为低优先级 preference data 进入上下文。没有隐藏提取、vector DB 或自动学习；本地 Memory 是明文。

## Settings

macOS preference 式 General、Models、Permissions、Memory、About；支持实时 System/Light/Dark、默认 provider、read approval policy、timeout 与 tool capability。Cmd+, 打开，键盘 focus 保留在 dialog，Esc 关闭并恢复。

## Error Handling

认证、限流、server、network、timeout、协议、tool failure、取消和中断使用安全可见状态。raw provider body/exception 不进入 UI/log；部分 streaming 文本在 Stop 后保存。

## Security

macOS 使用 Electron async safeStorage/Keychain 加密保存 API key；不可用时拒绝明文回退。Renderer 在用户输入时短暂持有 key，保存后只接收 `hasApiKey`，没有 key retrieval API。结构化日志只接受固定事件及有限 metadata；secret 扫描未发现真实凭据。conversation/tool output 明文存本机并可能发给用户选定的 provider。

## Tests

最终 **164 tests，0 fail，629 assertions，9 files**。覆盖 provider/core、真实 host/tools、permission、SQLite/main、renderer/IPC/native menus；包含草稿、rename、shortcut modifiers、focus、canonical context menu 与 clipboard 回归。

## Desktop E2E

native quit 时序修复后的生产资源真实 Electron **6 passed / 42.6 s**；旧 unsigned 开发 App 上一轮 **6 passed / 40.7 s**。最终完整 ad-hoc 签名 App 授权前首轮 **5 passed / 1 failed / 1.3 min**。用户已完成 Keychain 授权，plain fresh profile 保存显示 Key stored securely，并由真实 Cmd+Q exit 0；最终全套 E2E 已结束，为 **5 passed / 1 failed / 49.2 s**，新测试进程在 credential Save 的 Working 状态 10s 超时，该进程安全保存验证未完成，授权是否跨进程持久化未确认；不宣称 6 pass，不推断 Always Allow。覆盖配置/密文 key、agent 多步、审批、deny/Stop、child cleanup、quit/restart 与 native menus/keyboard/window/context menu/clipboard/appearance、notification API dispatch/click callback。关闭最后窗口先停止 task，再保留空闲 process；activation 重开恢复 history。

## Packaging

生成 `release/Prospero-darwin-arm64/Prospero.app`（约 289 MiB），ASAR、用户提供的 spectrum 图标、license/notices，bundle id `app.prospero.desktop`。最新 build 后执行 `bun scripts/package.ts` 生成此 bundle，已实际启动；最终包授权前 E2E 首项失败、其余五项通过；授权后 plain Save/quit 已成功；最终全套 E2E 5 passed / 1 failed / 49.2s，尚未 all-green。ASAR 内 6 个 runtime 文件与 dist 的 SHA-256 一致。图标沿用用户七条圆角 spectrum bars 的原始 PNG bytes，仅裁去展示用透明留白，未重绘。旧包完整签名无效，导致实际 native notification failed。相同资源的独立本地 ad-hoc 签名副本通过 deep/strict verification，真实 11 秒 minimized/unfocused 任务触发 native show；此修复已纳入最终 packaging，完整本地 ad-hoc 签名及 deep/strict verification 通过。没有 Developer ID 发布签名或 notarization；native show 尚不代表字面通知与实际点击已验收。

## Real Provider Smoke

**BLOCKED — real provider credential unavailable**。未提供真实 key/base URL/model；零真实 API 请求。已按条件要求检查，不把 offline 成功当成真实服务已验证。

## Documentation

README、ARCHITECTURE、DEVELOPMENT、SECURITY、PROVIDER-COMPATIBILITY、ROADMAP、DECISIONS、VALIDATION、MACOS-NATIVE-UI、本报告；包含实际 light/dark、Settings、palette、minimum window 与审批截图。明确 native 生命周期及安全边界。

## ADRs

6 个 durable decisions：desktop、provider、execution、permissions、SQLite、IPC/credentials。实现采用，等待 Chief Architect 最终 review。

## Dependencies

版本固定并保留 `bun.lock`；Bun frozen install 通过。没有 UI component library、额外 state framework、多 provider SDK 或系统级依赖安装。MIT与third-party notices 已保留。

## CI

GitHub Actions macOS workflow 已配置 frozen install、typecheck、lint、format、test、security audit、build、Electron E2E 和 package。没有 remote/push，因此远程 CI **未运行**。

## Validation

四轮本地自审完成：architecture、security/permissions、UX、tests/packaging。发现的问题已修并复验；所有必选本地 gates 通过，证据和适用边界见 [VALIDATION.md](VALIDATION.md)。

## Files Changed

共 92 个源码、测试、文档、配置与资源文件，包括 desktop app、五个 packages、build/dev/package scripts、unit/E2E、CI、docs 与用户图标。完整文件manifest位于 `output/validation/files-changed.txt`；生成的 `dist/release/output/node_modules` 均被忽略。

## Git Status

所有交付源码为 untracked/unstaged；index为空、0 commits、无remote。未执行 `git add`、commit或push，未修改 Ariel。

## Definition of Done

以下最后一项为条件要求；已检查其前提，实际真实 API smoke 未执行。

- [x] Electron desktop app reliably starts
- [x] React production UI
- [x] Codex-inspired polished desktop layout
- [x] New conversation
- [x] conversation sidebar
- [x] persistent conversations
- [x] OpenAI-compatible provider configuration
- [x] secure API key storage
- [x] configurable base URL
- [x] configurable model
- [x] Test Connection
- [x] streaming model output
- [x] Stop generation
- [x] real Agent execution loop
- [x] tool calling
- [x] read_file
- [x] list_directory
- [x] search_files
- [x] write_file with confirmation/diff
- [x] shell execution with permission
- [x] tool results continue into model
- [x] max-turn/runaway protection
- [x] cancellation
- [x] workspace picker
- [x] filesystem sandbox — 文件工具 capability boundary，shell为完整OS用户权限
- [x] path traversal protection
- [x] symlink protection
- [x] permission cards
- [x] allow-once
- [x] allow-session — 仅只读scope
- [x] deny
- [x] activity/tool timeline
- [x] user-visible execution status
- [x] Settings
- [x] Models settings
- [x] Permissions settings
- [x] explicit editable Memory page
- [x] dark theme
- [x] light theme
- [x] keyboard shortcuts
- [x] provider errors handled safely
- [x] renderer cannot access Node directly
- [x] secure IPC boundary
- [x] API key never reaches renderer where avoidable — 输入以外不回传
- [x] structured redacted logs
- [x] offline provider tests
- [x] agent loop tests
- [x] tool tests
- [x] permission tests
- [x] persistence tests
- [x] renderer tests
- [ ] desktop offline E2E — production 6 pass；最终 signed 包最新 5 pass / 1 fail / 49.2s；新测试进程的安全 credential Save 验证未通过
- [x] typecheck green
- [x] lint green
- [x] format check green
- [x] tests green
- [x] build green
- [x] CI configured
- [x] macOS app build succeeds
- [x] README accurate
- [x] SECURITY.md accurate
- [x] provider compatibility docs accurate
- [x] no real secret in repo
- [x] real API smoke if credential available — 条件未满足，实际 smoke BLOCKED，零真实请求

## Known Limitations

- 只验证 macOS arm64；没有发布签名/notarization 或 Windows/Linux packaging。
- 真实provider compatibility仍需有credential的有限smoke；不支持Responses、custom headers、legacy function_call、multimodal。
- 同时一个active task；没有自动context compaction。草稿仅保存于当前renderer内存。
- 文件/输出/diff有硬限额；write仅UTF-8和已有父目录。
- shell具有完整OS用户权限；恶意本地路径竞争、脱离process group和硬崩溃清理不能给出内核级保证。
- 本机conversation/Memory/tool output明文存储。已知API key反射redaction不是通用DLP。
- 没有browser computer-use、scheduler、cloud sync、连接器、自动memory、Tempest或额外Agent runtime。
- literal Dock 点击、物理 trackpad inertia、VoiceOver 语音与真实 OS notification delivery/click 尚未人工验收；nativeTheme/media、拦截 Notification API 与受控 focus gate 单独记录。全局 System appearance/Reduce Motion 已实际切换并恢复；Cmd+Q 与 native menu Quit 已观察 exit 0；独立 ad-hoc 签名副本的 native notification show 成功，用户已完成 Keychain 授权，plain credential Save / Cmd+Q 已通过；字面通知/click 的 CUA timeout，未记为通过。

## Blocking Findings

完整本地 ad-hoc packaging 已通过；最终 signed 包授权前首轮 E2E 曾为 5 passed / 1 failed；当时 plain fresh profile 的 dummy credential 保存同样 Working，并观察到 SecurityAgent。CUA 安全限制禁止操作该受保护系统认证 UI，用户现已明确确认完成授权。随后 plain signed 包 fresh profile 显示 Key stored securely，真实 Cmd+Q exit 0；这只证明该 plain 进程已获准；最新最终全套 E2E 为 5 passed / 1 failed / 49.2s，新测试进程在安全保存 Working 状态 10s 超时，该进程安全保存验证未完成，授权是否跨进程持久化未确认。不能推断用户选择了 Always Allow。按用户要求，本轮停止进一步验证。普通通知许可已允许，用户已处理过一次 Keychain 授权，后续进程的授权状态未确认。真实 provider smoke 缺少 credential，字面通知/click 尚未验证。

## Chief Architect Review Questions

1. 是否认可只读session授权范围，以及write/shell始终逐次批准、shell具有完整OS用户权限的v0.1边界？
2. 是否认可core/provider/host/persistence职责与SQLite + safeStorage选择，继续推迟Tempest提取？
3. 是否认可当前macOS arm64开发bundle，并在发布时单独确定稳定签名身份、notarization和真实provider兼容性验收？

Prospero v0.1 implementation is complete locally,
but remains UNSTAGED, UNCOMMITTED and UNPUSHED
pending Chief Architect final review.
