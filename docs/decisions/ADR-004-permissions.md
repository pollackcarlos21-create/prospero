# ADR-004 Permission and local tool capability

Status: implemented locally, pending review. Date: 2026-10-03.

Host prepare 负责真实 preview，core 按 risk 调用 PermissionPort，host execute 只在批准后。默认 read 自动允许且受 workspace/exact attachment scope 限制，Settings 可开启 read approval。allow-once/allow-session/deny 是领域语义；read session scopes 仅内存且包含 identity。

Write 与所有 shell 每次批准，不用字符串 regex 宣称 shell 安全。完整 bounded diff 超限直接拒绝，批准后 revalidate stale state。Shell cwd 不是 OS sandbox，权限卡明确完整用户访问。所有输出/扫描/进程时间设边界，不立即创建 persistent ACL/plugin system。
