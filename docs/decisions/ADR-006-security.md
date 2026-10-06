# ADR-006 Narrow IPC and OS-backed credentials

Status: implemented locally, pending review. Date: 2026-10-03.

Preload 固定业务 API，main 验证精确 sender/frame/URL 与运行时 inputs，不提供 generic IPC invoke、fs、shell、eval。Renderer sandbox/context isolation/Node off 与 CSP 配合阻断 remote content 获取 privileged host。

生产 key 用 Electron async safeStorage、macOS Keychain-backed encryption；只把密文存 SQLite，key 不从 main 回传。不可用时 fail closed。endpoint/key 绑定与 provider mutation reservation 防止跨服务 credential reuse/race。开发 fallback 绑定明确 endpoint，packaged 禁用。日志仅固定 codes。发布未签名/notarized，需后续 signing identity review。

2026-10-04 增量：绑定写入 OS-encrypted versioned envelope，而不只依赖 metadata 和运行时 reservation。新 ciphertext 保存后若 provider SQL 保存失败，旧 endpoint 的 get 仍拒绝，重启后相同。旧格式仅在成功读取、signal 未取消、同 provider reservation 仍有效时按已有 endpoint 迁移。逻辑等待限 30 秒（Web probe 15 秒），与实际 native settle 分离；取消后 reservation 继续保留，晚到结果不得写入或发起 HTTP。窗口关闭/quit 拒绝新操作，重开窗口显式恢复；不承诺物理取消 OS 弹窗或冷启动 native 可用性。

Native integration 沿用同一窄边界：context menu 使用固定 typed targets，message Copy 读取 main-owned saved content，Finder/Copy Path 仅精确 workspace/attachments 或 workspace 内已知 preview paths。准备和 action 时复核路径链与 symlink，renderer 不能发起 arbitrary path/URL/command。Clipboard 只暴露有大小限制、等待完成的系统写入，不提供读取。

原生长任务完成通知仅在失焦时发送通用提示，不包含任务内容或路径。窗口关闭先禁止新执行、abort 并等待 cleanup，macOS 保留的 process 为空闲状态；Dock 重开不恢复工具，Cmd+Q 清理后退出。Native appearance/accessibility events 不修改全局 OS 设置。详见 [Security](../SECURITY.md) 与 [macOS-native UI](../MACOS-NATIVE-UI.md)。
