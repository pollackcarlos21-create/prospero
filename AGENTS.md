# Prospero engineering instructions

- 项目是 desktop personal agent，不是 coding-agent wrapper。所有工程报告使用中文；代码/API 使用英文。
- 保持 `core → nobody`；provider wire protocol、host filesystem/shell、SQLite 和 Electron/React 分属各自 owner。
- 不创建 Tempest/shared/common/utils package，不修改 Ariel，不自动安装系统软件。
- Renderer 不可访问 Node、env、API key retrieval、任意 IPC channel、通用 fs/shell RPC 或 eval。
- 任何 write/shell 必须 main-owned permission 与完整 preview；不能通过工具间转换绕过拒绝。
- credential 仅在主进程解密；存储必须 OS-backed 密文；复用 key 必须绑定 endpoint；异步 provider 配置操作必须占用同一 provider。
- 文件工具验证路径链、symlink、inode 与 stale-write snapshot；shell 必须 output cap、minimal env、timeout/abort/process-group cleanup。
- 新测试使用 temp directories、fake HTTP、无真实 credentials。真实 API smoke 仅显式环境提供 credential 且离线 gates 通过后运行，最多三次 HTTP request。
- 修改后运行 README 的 quality gates；影响 main/preload/provider/host 的修改须重建并运行 Electron E2E。
- `bun run package` 会覆盖本项目生成的 release 输出；不会触碰用户目录之外的数据。源码保持 UNSTAGED/UNCOMMITTED/UNPUSHED，除非用户另行授权。
