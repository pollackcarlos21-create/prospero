# ADR-005 SQLite persistence

Status: implemented locally, pending review. Date: 2026-10-03.

实际验证 Bun1.4.2 的 node:sqlite 与 Electron44.5.1 内置 Node24.21.0/SQLite3.53.4 后，采用 Node built-in DatabaseSync，避免第三方 native addon ABI 重建和自造 JSON database。

SQLite WAL、foreign keys、busy timeout、PRAGMA user_version=1 migration；conversation snapshots、settings/provider metadata、execution summaries 和 credential ciphertext 分表。离散事件即保存，stream chunks batch 仅 UI；断电可丢最近未完成 streaming text，已保存 history 保留。更高 schema version 明确拒绝，避免静默破坏。
