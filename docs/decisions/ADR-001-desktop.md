# ADR-001 Electron desktop architecture

Status: implemented locally, pending Chief Architect review. Date: 2026-10-03.

需要 filesystem/process/credential 等桌面能力，采用 Electron main privileged host、sandboxed preload 与 React renderer。生产加载本地 Vite output，localhost 仅开发 HMR。TypeScript 小型 workspace monorepo 与 Bun project tooling。没有 system Rust 依赖、browser-only 产品或 renderer Node access。

Bundle id 采用 `app.prospero.desktop`，尚无已批准域名/remote identity。未来发布 identity 改动必须考虑 Keychain 与 userData migration。先独立发展 Prospero，不创建 Tempest 或绑定 Ariel。

macOS 是 v0.1 的首要平台。采用 `hiddenInset` unified titlebar、系统 traffic lights、native menu roles、native dialogs/context menus/system clipboard/notifications，而非网页导航栏和自制桌面控件。视觉层以 warm surface tone、spacing、rounded geometry 与少量 spectrum accents 表达层次；约定见 [macOS-native UI](../MACOS-NATIVE-UI.md)。不 bundle Apple fonts 或复制品牌资产。

生命周期遵循 macOS：最后窗口关闭先 suspend task startup、abort 并等待工具清理，再保留空闲 App process；Dock activate/second-instance 重开唯一主窗口。Cmd+Q 等待清理后关闭 SQLite 并真正退出。Native menu commands 在 renderer ready acknowledgement 后发送，重开时不丢失命令，不自动恢复 Agent execution。

Light/Dark/System 与 native chrome 同步，监听系统 appearance 和 accessibility display changes；Reduce Motion 减少动画，Reduce Transparency 移除 sidebar vibrancy。Keyboard 使用 macOS Command conventions，保留 Ctrl+Cmd+F native fullscreen。发布签名/notarization 仍属于后续 release identity 工作。
