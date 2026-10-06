# Prospero v0.1 local validation

验证时间：2026-10-03（Asia/Shanghai）。这是本机实际执行记录；GitHub Actions 尚未远程运行，真实 provider smoke 因缺少 credential 未执行。

## Environment

- macOS Darwin 25.6.0，Apple Silicon arm64。
- Bun 1.4.2，宿主 Node 24.14.0，Git 2.55.0。
- Electron 44.5.1；实际 runtime Node 24.21.0 / SQLite 3.53.4，已验证 `node:sqlite` 可用。
- Python 3.14.3 可用；Rust 不存在，本实现不需要 Rust 或系统级安装。
- 实现目录 `/Users/chadrayfoo/Projects/prospero` 原先不存在；新建独立 Git repo。没有修改 Ariel 或 chat 原始 cwd。

## Final gates

| Command / check | 本机结果 | Evidence |
| --- | --- | --- |
| `bun install --frozen-lockfile` | PASS，固定 lockfile 安装 | 本次实现安装检查 |
| `bun run typecheck` | PASS | `output/validation/macos-typecheck.log` |
| `bun run lint` | PASS | `output/validation/macos-lint.log` |
| `bun run format:check` | PASS | `output/validation/macos-format-check.log` |
| `bun test` | **164 pass，0 fail，629 assertions，9 files** | `output/validation/macos-unit-tests.log` |
| `bun run security:audit` | PASS，未发现真实 secret 候选 | `output/validation/macos-security-audit.log` |
| `bun run build` | PASS，图标与 native quit 时序修复后执行 | `output/validation/macos-build.log` |
| `bun run test:e2e` | **6 passed，42.6 s**，真实 Electron + production resources | `output/validation/macos-desktop-e2e.log` |
| `bun scripts/package.ts`（紧接最新 build） | PASS，完整本地 ad-hoc 签名开发 `.app` 已生成并通过 deep/strict verification | `output/validation/macos-packaging.log` |
| signed 包首轮 E2E（授权前历史） | **5 passed，1 failed，1.3 min**；首项 encrypted credential Save 等待 OS Keychain 授权 | `output/validation/macos-signed-e2e-before-keychain-authorization.log` |
| signed 包最终 E2E（用户授权后） | **5 passed，1 failed，49.2 s**；新测试进程 credential Save 仍停于 Working / 10s timeout | `output/validation/macos-packaged-e2e.log` |
| plain native Cmd+Q 与 credential Save | PASS，fresh profile 的实际包显示 Key stored securely，PID 8046 Cmd+Q exit 0；无 instrumentation | `output/validation/plain-native-quit-confirmed.json` |
| Packaged bundle integrity | PASS，main/preload/HTML/renderer assets 共 6 个文件与 `dist` 的 SHA-256 一致 | `output/validation/macos-bundle-integrity.log` |
| 图标原始字节来源 | PASS，SVG 内嵌 PNG 与先前记录的用户附件 SHA-256 一致 | `output/validation/icon-provenance.log` |
| `bun run smoke:real` | **BLOCKED — real provider credential unavailable**，零真实 API 请求 | `output/validation/real-provider-smoke.log` |
| Git index / history / remote | 无 staged files、0 commits、无 remote | `output/validation/git-status.log` |

生产 E2E 已包含 native Cmd+Q 时序修复。旧 unsigned 开发包上一轮为 6 passed / 40.7s；完整 ad-hoc 签名的最终开发包授权前首轮为 5 passed / 1 failed，不能沿用旧包全绿结论。首项当时停于 API key 安全保存。用户现已明确确认完成 OS 授权；plain app 已保存测试 credential，最终 signed 全套 E2E 已结束：5 passed / 1 failed / 49.2s。

生成文件和本地日志被 gitignore；文档截图单独保留于 `docs/screenshots`。日志不是源码版本控制的一部分。

## Test coverage

9 个 Bun test 文件覆盖 core/providers、真实 tools/local-host、persistence、renderer、main service、IPC boundary 和原生 menu。

- Provider：endpoint/auth/redirect policy、SSE text/UTF-8/tool deltas/finish/usage、malformed protocol、401/429/500、timeout/abort、反射已知 credential 的跨 chunk redaction、禁用 tool capability、连接测试回退。
- Core：多轮/多工具继续、deny/failure result、max turns/calls/deadline、Stop、部分文本持久化、剩余 tool history 配对、安全失败卡片、observer failure 隔离。
- Tools/host：严格参数、实际 temp 文件操作、traversal/symlink/attachment scope、stale diff/identity/hash/hardlink 检查、完整 diff 上限、read session scope identity、真实 command/output/timeout/TERM-resistant descendants、受控环境、实际 Bun/npm 命令。
- Persistence/main：SQLite migration/version拒绝、settings隔离、conversation restore、interrupted repair、不自动重新执行、encrypted credentials 的 endpoint binding、provider mutation concurrency、permission policy concurrency。
- Renderer/IPC：主题、精确 macOS shortcut modifiers、palette、focus trap/restore、sidebar inert、rename/delete sheet、settings/memory、conversation switching、草稿保留、stream update、错误和历史许可状态、trusted sender/URL/frame/args 验证。
- Native integration：六菜单及原生 roles、生产无开发菜单、canonical context targets、异步 clipboard、Finder path 复核、window suspend/resume 和 native appearance contract。

## Desktop scenarios

两组 E2E 都使用独立临时 profile/workspace 和本地 fake server；不访问用户已有数据库，不调用真实模型 API。production Electron 的六个场景通过；最新 signed packaged executable 的其余五项通过，首项在授权前未通过；用户授权后的 plain app 保存已成功；最终另一测试进程的首项仍在 credential Save 超时，详见下面记录。

1. 配置 provider → Test connection → 保存加密测试 key → 新 conversation → attach workspace → read result进入下一 model turn → shell审批和实际执行 →完整write diff审批和实际文件修改 →最终回答 →theme/memory保存 →quit/restart →history恢复 →已保存key可解密测试且密码字段为空 →继续原conversation。数据库和日志不含测试key。
2. 批准慢 shell 后 App quit，实际 child pid 消失；重启不自动执行旧任务。独立的慢 model task 被强制中断后，重启标记 interrupted，并可继续 conversation。
3. deny shell无文件副作用；Stop abort model连接并保存部分文本；Stop取消permission等待且不启动命令；批准后的慢shell Stop清理child；401只显示安全错误；Ask reads + read session grant 在后续task复用正确scope。
4. 六个 native 菜单、keyboard palette/settings/search/sidebar、focus、renderer isolation、760×560 resize、125% scaling、maximize/fullscreen/minimize/activation、nativeTheme light/dark 实时样式、主要 surfaces 无 border，以及 reduced-motion 媒体模拟。
5. native context menu Rename、系统 clipboard 写入与恢复、批准慢 shell 后关闭最后窗口清理真实 child；零窗口时 process 存活，activation 重开恢复 stopped history，未自动重跑。
6. notification dispatch：short task 在真实 minimized/unfocused 状态下不通知；11 秒真实 model task 的受控 focus gate 不通知；11 秒任务在真实 native minimize/unfocused 状态完成后捕获真实 Notification 实例的 generic/silent API dispatch，并验证 click callback 恢复窗口。测试模拟 support/focus gate、拦截 `show()`，不发送 OS notification；不据此声称真实系统通知送达或 literal 点击已通过。

最终截图位于 `docs/screenshots`，包含 light/dark welcome、Settings、command palette、minimum window、permission 与 conversation。已查看实际 render、完整 diff 和原生 app icon。E2E 使用 dialog mock 让 workspace/file 选择确定；另通过实际 CUA 操作 native workspace picker、Rename、Reveal in Finder、fullscreen 和 Zoom。完整证据层级和未验项目见 [macOS-native UI 验收矩阵](MACOS-NATIVE-UI.md)。

Mac 已解锁。最新实际 CUA 已验证 Cmd+,、Cmd+K、Cmd+F、Cmd+Shift+P、Settings Tab 和 Ctrl+Cmd+F fullscreen/restore；真实右键 Rename 为 Native design review 后 sidebar/header 都更新，Delete sheet 打开后 Esc 取消。Attach picker 真实打开并定位 README，但 Open disabled，Esc 取消，未完成 attachment 选择。AX Zoom SecondaryAction 改变窗口尺寸；drag resize 接口返回 noWindowsAvailable，因此仍只引用 E2E native setSize 作为 resize 证据。

此前真实 Cmd+Q 后进程留存的问题已复现并修复：完成 shutdown 与 store close 后，将第二次 app.quit 安排至下一事件循环轮次。修复后真实 Cmd+Q、无 heartbeat probe 的日志 `output/validation/native-quit-after-fix.jsonl` 完整记录 before-quit prevent → 第二次 quit → window.closed → will-quit → process.exit 0，控制器确认 PID 6346 exit 0。该 probe 保留 instrumentation；随后真实 native Cmd+Q 与 native menu Quit 均观察到 process exit 0，约 78ms/105ms。生产与旧开发包 E2E 已重新通过。其后正式 signed 包、独立 fresh profile、无 Playwright/无 instrumentation 的实际 CUA Cmd+Q 确认 PID 8046 exit 0，见 `output/validation/plain-native-quit-confirmed.json`；这是独立于 probe 的退出证据。

System Settings 中实际操作 Reduce Motion off → on → off，native/renderer reducedMotion true/false 与 sidebar transition 0s → 0.2s 对应，原设置已恢复。全局 appearance 实际 Automatic → Light → Dark → Automatic，app 使用 System，warm light / graphite dark 的真实 native 截图已确认，原设置已恢复。日志 dark 事件后的即时 renderer snapshot 存在 React 更新时序，未将其当作稳定状态证据。

E2E app 内 `nativeTheme.themeSource` 切换与 `emulateMedia` 仍单独记录；全局系统设置的实际操作证据在上一段。literal Dock 点击、物理 trackpad inertia、VoiceOver 语音仍需人工验收；尚未执行的项目不记为通过。

## Native notification 与签名进度

实际 11 秒任务在 minimized/unfocused 状态下，旧 release 包收到 native notification failed；该包的完整应用签名无效，继承的 Electron linker signature 不足以覆盖最终 bundle。相同 runtime 资源的独立副本 `output/validation/signed-probe/Prospero.app` 经过完整本地 ad-hoc 签名，`codesign --verify --deep --strict` 通过；再次实际执行 11 秒任务，`notification.native-show` 成功。系统常规通知许可已接受，System Settings 中出现 Prospero 通知设置。

证据为 `output/validation/native-adhoc-signing.log`、`output/validation/native-notification-before-signing.jsonl` 与永久保留的 `output/validation/native-notification-after-signing.jsonl`。后者为 2 次实际 attempt、2 次 native-show、0 次 failed。Native show 证明原生 scheduling/show 回调成功，尚不等于屏幕上字面通知可见或真实通知点击恢复；字面通知与 click 的 CUA 查询 timeout，未记为通过。完整 ad-hoc 签名已纳入最终 packaging 并验证；它是本地开发签名，不是 Developer ID，也不是 notarization。

## OS Keychain 安全授权交接

最终完整 ad-hoc 签名包的首个 E2E 在 Save provider 后等待列表恢复，超时失败；其余五项通过。独立 fresh profile 的实际 packaged app、无 instrumentation 操作，用 dummy marker 保存也停留在 Working；同时观察到 macOS SecurityAgent 启动。该行为与首次 OS-backed safeStorage/Keychain 授权交接一致，当时授权尚未处理，未据此判定保存成功或降级为明文；首轮日志保留为 `output/validation/macos-signed-e2e-before-keychain-authorization.log`。

CUA 对 `com.apple.SecurityAgent` 的操作被安全限制明确禁止，agent 未自动点击受保护系统认证 UI。用户现已明确回复“已完成授权，继续验证”。随后普通正式 signed 包、独立 fresh profile 的实际 UI 显示 Local credential probe / Key stored securely，credential Save 已完成；Escape 后真实 Cmd+Q 退出成功且无 instrumentation。普通 macOS notification 与 Keychain 授权均由当前系统交接处理，不能写作所有安全权限保持不变。最终 signed 包全套 E2E 已结束，为 5 passed / 1 failed / 49.2s。首项新测试进程的 credential Save 仍停在 Working 并于 10s 超时；本轮没有直接捕获该进程的 SecurityAgent 提示；授权是否跨进程持久化未确认。用户先前完成一次授权和 plain Save 成功，不证明已选择 Always Allow，也不证明后续所有进程会自动获准。未声明 all-green；按用户“尽快结束”的要求，本轮停止进一步测试与调查。

## Four self-reviews

这是实现团队的本地自审，最终批准仍属于 Chief Architect。

1. **Architecture**：复核 package依赖方向、core host-neutral契约、application composition、同一取消信号、history配对和恢复。修复取消提前返回导致shell清理竞争、无效请求缺少可见audit卡片等问题。
2. **Security / permissions**：复核 renderer隔离、IPC allowlist、credential binding/concurrency、路径和文件identity、完整diff、每次write/shell许可、session read scope、redacted logs。修复endpoint/key竞态、scope identity和设置共享对象问题。
3. **UX**：查看两主题实际桌面、审批 diff、错误与中断状态、输入焦点及原生快捷键。修复草稿丢失/延迟覆盖、空 task rename header 和 Ctrl+Cmd+F 被 Cmd+F 抢占；复核无框 surface、minimum window 和 scaling。
4. **Tests / packaging**：完成最终全套gates、生产桌面E2E、实际 `.app` E2E、重启恢复/凭据解密/child cleanup、icon/ASAR/license检查和文档对照。

## Packaging boundary

App 位于 `release/Prospero-darwin-arm64/Prospero.app`，约 289 MiB，bundle id `app.prospero.desktop`，version `0.1.0`。已从此 bundle 直接启动和测试。未进行 Developer ID 发布签名或 notarization。旧包仅继承 Electron linker signature，完整 bundle 签名无效；正式生成的开发 release 已完成完整本地 ad-hoc 签名，deep/strict verification 通过。该签名改变后的首次 Keychain 交接已由用户完成，plain fresh profile 的 credential Save 已成功。

图标使用用户提供的七条圆角 spectrum bars。`assets/icon.svg` 内嵌原始透明 PNG bytes，仅通过 `viewBox="240 128 1056 768"` 裁去展示用透明留白；不重绘、不修改原图像素。内嵌 PNG SHA-256 为 `95a6f0fef9fa2f06bfee86c78adb54d9269c99b7958760a4f8d15ef62f5020d4`，与先前附件记录一致；临时原附件路径已消失，本轮依据保留的 hash 记录验证。应用内八处 Mark 共用此 SVG，Dock 打包从同一 SVG rasterize 为 ICNS。最新 packaged renderer 与 app 图标截图已查看。

Packager关于未提供新 `.icon` 格式的warning不影响已有 `.icns` 图标；已确认bundle的图标资源和实际图像。没有安装系统软件。已接受普通 macOS notification 许可；Keychain 系统授权已由用户确认完成。

## Evidence limits

- Fake-server成功不能证明所有真实OpenAI-compatible服务兼容；条件要求的真实API smoke当前缺少credential。
- shell拥有OS用户权限；workspace cwd不是OS sandbox。文件工具边界已测试，但不声称能原子阻止恶意本地进程的所有并发路径替换。
- graceful quit/Stop/renderer crash/可处理main exception清理同一POSIX process group；主动daemonize/setsid/另建group、SIGKILL、断电或无法运行cleanup的OS crash不在保证内。
- CI配置已写入，没有remote/push，因此没有remote CI结果。

实现、native quit 时序修复、完整本地 ad-hoc packaging 和 plain credential Save / Cmd+Q 已验证。最新 signed 包 E2E 为 5 passed / 1 failed / 49.2s，新测试进程的安全保存验证未完成，授权是否跨进程持久化未确认，安全保存全程验收未通过；字面通知/click 仍未验证。本轮已停止进一步验证。所有源码保持 UNSTAGED、UNCOMMITTED、UNPUSHED。
