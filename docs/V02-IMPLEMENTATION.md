# Prospero v0.2 Computer & Web Action Layer

本文记录当前实现的 owner、权限与数据边界。最终验收见 [V02-VALIDATION](V02-VALIDATION.md)；实现与离线验收不等于真实服务或完整人工 native 验收。

## 保留的 v0.1 基础

v0.2 继续使用现有 Electron main / secure preload / React renderer、macOS surface 与更新后的 Prospero 标识、单 Agent loop、`ModelPort` 和 Chat Completions provider。新增能力通过工具和 main-owned adapter 组合，不替换模型接口，也不把 Electron、SQLite 或网络协议移入 core。

renderer 仍无 Node、通用 filesystem/shell RPC、任意 IPC channel、凭据 retrieval、环境变量读取或通用执行器。真实服务调用不属于本轮离线验收的授权范围。

## Owner 与契约

| Owner | 当前责任 | 不获得的能力 |
| --- | --- | --- |
| `@prospero/core` | Effect、scope/reference、structured action、immutable plan、journal port、source record；Agent loop 与权限/取消语义 | Electron、文件 I/O、网络协议、SQLite、凭据 |
| `@prospero/tools` | provider-facing declarations、严格参数 schema 与执行前校验 | 自行授予 scope、执行 I/O |
| `@prospero/local-host` | scope/path 验证、文件预览与 projected state、逐动作执行、legacy write/shell 拒绝防绕过 | 搜索凭据、Web transport、renderer |
| `@prospero/persistence` | schema 2 migration、immutable plans、append-only journal、SourceRecord retention、已有 provider/settings/密文存储 | 解密凭据、执行 actions、自动重跑 |
| `@prospero/web` | Brave Search、公开 HTTPS fetch、正文提取、source identity/hash/citation 校验 | Electron、模型调用、文件/shell、持久化 |
| Electron main | adapter composition、native dialog、credential vault、审批、native actions、retention projection 与 typed IPC | 向 renderer 导出上述通用能力 |
| renderer | scope 选择入口、Action Plan approval、file preview、Sources/citations、Web Search settings | 用页面或模型输出授予权限、改写已批准计划 |

Effects 明确区分 `file.read`、`file.write`、`file.remove`、`process.execute`、`network.search`、`network.fetch`、`native.reveal` 与 `native.clipboard`。工具参数不接受未声明字段；structured actions 的不同 kind 使用精确 `oneOf` schema。参数在 host preparation 前再次本地校验，包含结构、整数边界、NUL、UTF-8 byte budget 与批次数量限制。

`file.read` 以外的 effects 即使被 adapter 标为 read，也必须审批且不能获得 session grant。已有无 effects 的 read host 保持兼容；纯读取继续采用既有 scope-bound session 设置，grants 不持久化，scope/policy 改变或重启不保留它们。ModelPort、renderer 或 source text 都不能扩大 grant。

## 明确的多根文件 scopes

通过 main-owned native file/folder picker 选择 scopes。每个 scope 有应用颁发的 ID、canonical path、标签、read/write mode、directory/file kind 与设备/inode identity。工具使用 `scopeId + relative path` 引用；模型不能提供新的 root path 或自行升级 read mode。

directory scope 可以明确选为 read-only 或 writable；精确 file attachments 只提供该文件的读取能力，不提供其 parent directory 的遍历或写入能力。现有 workspace 保留兼容入口。改变 scope mode 需要重新明确选择；运行中的任务先 Stop，再更改 scopes。

解析路径拒绝 parent traversal、NUL、越界、symlink path components 与不可用/replaced scopes。准备和执行都检查 root identity 与 path chain。写源/删源要求 writable directory scope；从 read-only scope copy 到 writable scope 只读取源文件。

v0.1 旧数据没有可恢复的持久化 root identity，首次使用会捕获当前根身份；这不能回溯证明旧路径在升级前没有被替换。v0.2 的新选择与迁移后的 scopes 都保存身份，后续替换需要重新选择。

当前范围选择最多 20 个 scopes。scope identity 是应用维护的授权边界，不是权限被永久授予该 pathname 的承诺。

## Structured actions 与完整预览

首批 action kinds：

- `copy_file`、`move_file`、`rename_file`：普通文件的内容操作，可跨已选根；目标不能覆盖已有对象。
- `create_directory`：创建明确指定的目录，可作为后续动作的 projected dependency。
- `write_text`：创建/替换 UTF-8 文本，显示完整有界 diff；拒绝 binary、无效 UTF-8、hard-linked target 和过大预览。
- `trash_file`：通过 main 的 macOS Trash adapter 处理普通文件。
- `reveal_in_finder`、`copy_path`：通过 main 的窄 native adapter 接收已验证 canonical path。

批次最多 25 个动作。普通文件 copy/move 的单文件上限为 32 MiB；所有文本写入内容的批次总预算为 256 KiB，完整 diff 超过 32 KiB 时拒绝准备。目录树 move/copy 不属于本版 action kind。

准备阶段计算 projected state，使 `mkdir → move → copy`、嵌套目录创建与多次文本修改可以形成同一批次。原始 snapshot、source bytes 与依赖由 host 私有持有；公开 Action Plan 提供明确 source/target、effects、bytes、before/after hashes 和适用 diff。

Plan 包含 application-generated ID、createdAt 和 SHA-256 manifest digest；公开 plan 和嵌套数组冻结。审批绑定当前 request ID 与 digest，只有 Allow Once / Deny；授权覆盖这些不可变动作，不覆盖改动后的参数、下一批动作或自动重试。

## Durable journal 与执行侧处理

schema 2 新增 `action_plans`、`action_journal` 和 `web_sources`，保留已有 conversations、settings、providers、encrypted credentials 与 executions。未来 schema version 被拒绝，不修改成旧版本。

`prepare` 在同一 SQLite transaction 中持久化 plan 和全部 prepared actions。相同未决 plan 的完全相同 payload 可以幂等准备；同 ID 的内容或 owner 改变被拒绝。数据库 trigger 保护 plan 的 immutable fields 与 journal 的 append-only 行；conversation deletion 仍按 foreign-key cascade 清理相关记录。

一批动作的审批 decision 持久化后，每个动作必须先成功提交 running entry，才能开始 effect。running commit 失败不执行文件或 native effect。执行按依赖顺序进行：检查 scope/snapshot，写 running，再重新检查路径/内容，执行 effect，验证已批准的 postcondition，最后写 succeeded。

创建文件使用 exclusive/no-follow open；copy 目标不覆盖。move/rename 先完成目标内容并 sync，再删除仍符合 pinned snapshot 的源文件。因此它们不是跨文件系统的整个批次 atomic transaction；源删除或之后步骤失败时，已发生的目标 effect 会保留并明确报告 partial。

| 情况 | 执行与 journal 结果 |
| --- | --- |
| Deny | 同一 transaction 将所有尚未开始动作记为 denied；尚未开始的批准也可撤销；后续 write/shell/native mutation 无法通过换工具绕过 |
| Stale | 停止当前动作，保留外部变更，剩余动作 terminalize；如果之前已有 effect，plan 为 partial |
| Partial failure | 保留已成功/可能发生的 effect，记录具体动作的 failed/stale/cancelled 与后续 skipped，不声称已回滚 |
| Stop | 等待 host cleanup，保留返回的真实 partial result、journal 和成功动作；未执行动作取消/跳过，不再请求下一步 mutation |
| Restart | prepared/approved plans 变为 interrupted；已有 succeeded 保留，running 记录提示 effect 可能已经发生；未开始动作说明 approval 未保留；不自动重跑 |

plan 只有全部动作 succeeded 才能完成为 completed。已成功部分和真实/可能部分 effect 需要 partial，不能用 failed 隐去 effect。所有动作必须 terminal 后才能正常 finish；journal 本身无法提交时停止执行，重启按 interrupted 恢复，不制造 completed。

Action Plans 与 journal 持续保留到所属 conversation 删除，不受 Web source TTL 影响。

## 独立 Web layer

首版搜索 provider 固定为 Brave Web Search。搜索 credential 只传入固定 HTTPS Brave endpoint；搜索不跟随 redirect，token 不进入 page fetch。搜索 query 在调用前显示审批，fetch 显示 canonical URL；每次请求只使用一次批准，不复用 session grant。

公开 page fetch 只接受无 userinfo 的 HTTPS，拒绝非标准 port、private/loopback/link-local/reserved address 与不安全 hostname。连接前解析所有 DNS addresses，拒绝混合 public/private 答案；transport pin 到已验证地址，并核对实际 remote address。每一跳 redirect 重新执行 URL/DNS 验证，并保留 redirect、timeout、headers 和累计 body budgets。

生产 transport 使用 TLS certificate 验证、独立连接与无 cookie/Authorization 的固定 page headers，不用浏览器 session，不执行页面脚本。首版提取支持 UTF-8 HTML；不支持内容或超限响应明确失败。HTML parser 提取 main/article/body 文本，跳过 scripts、forms、iframes、hidden elements 和其他 active content。它不是 browser computer-use。

正文抽取与删除 active content 不会把页面变成可信指令。外部内容仍明确标为 untrusted data；模型的 system policy、每次审批与执行侧 scope/journal checks 共同阻止内容中的指令获得本地、native 或 network 权限。离线 injection 测试不能证明任意真实模型永远不会提出恶意工具调用，因此执行侧仍逐项检查和审批。

## Source provenance 与 citations

每个 retrieved source 具有 canonical URL、title、kind、retrievedAt、SHA-256 contentHash、内容身份派生的 source ID 与有界 excerpt。相同 URL 的内容变化获得不同身份；来源 identity 不可以被重新绑定到不同 URL/hash/kind。

模型使用 `[source:src_…]` 引用实际返回的 source。UI 仅把当前保存的 source ID 映射为来源按钮；不把模型生成的任意 URL 当成 provenance。独立 citation resolver 校验 ID、kind、URL 与 content hash 关系；unknown/forged references 不获得可执行 source link。

来源身份/hash 提供可追踪性，不等于逐句证明 assistant 的陈述正确，或证明网页本身可信。

打开 Source 通过 typed IPC 提交 conversation/source ID，由 main 查已保留来源并验证 URL 后交给系统浏览器；renderer 不能指定一个替换 URL。

## 搜索凭据与 retention

Brave Search 默认 disabled；Settings 提供启用、输入/移除 search key 和 Source retention 选择。credential vault 使用既有 OS-backed `safeStorage`，SQLite 只接收 ciphertext。renderer/bootstrap 只看到 `hasApiKey`，不能取回 key。settings 保存/移除期间和 active task 期间的竞争由 main 拒绝；搜索 key 与模型 provider key 分开持有。

| 数据 | 生命周期与存储 |
| --- | --- |
| 模型 provider / Brave credential | main vault 解密；OS-backed 密文保存；不进入 renderer 或 page headers |
| 完整搜索/网页 tool body | 仅本次 model execution；conversation snapshot、renderer IPC 和后续执行 history 投影为固定说明，不保存完整原始正文 |
| SourceRecord（默认 `sources`） | 独立 `web_sources` 表，保存 URL/title/kind/time/hash 和最多 1200 字符 excerpt，七天 TTL |
| SourceRecord（`session`） | 当前 application session 的 main conversation map，重启不恢复；选择 session 会清除既有 durable source rows |
| User / assistant conversation text | 按现有 conversation lifecycle 保存，直到 conversation 删除；assistant 自行引用/总结的文字不受 source-row TTL 影响 |
| Web query / URL audit | 工具请求/preview history 继续随 conversation 保存；Source retention 不等于抹除 query 或 URL audit |
| Action Plan / journal / scope selections | 按 conversation lifecycle 保存；restart 不保留批准，不触发自动执行 |

source metadata 不重复嵌入 conversation snapshot；完整正文不作为 memory entry、model provider 配置、source row 或 action journal 保存。模型生成的总结和用户自行粘贴的网页文字属于会话内容，不是系统截获的 raw web body。

七天 TTL 在 startup 与 Sources read 时删除所有过期 `web_sources` 行，并在读取结果中再次过滤；即使长期不执行新搜索，也不返回过期 provenance。这里的删除表示应用/数据库逻辑删除，不承诺清除用户备份、SQLite 历史页或 SSD forensic remnants。

## UI 增量

保留现有 macOS layout、更新后的标识、warm rounded surfaces、composer 与 tool timeline。只增加必要的 scope selection、file-operation preview、Action Plan approval/journal、Sources/citations 与 Web Search settings；不增加完整 browser、通用桌面控制台或 dashboard。

Action Plan approval 展示明确动作和 effects；file preview 对 write_text 使用已有 soft diff surface。Sources 与完整日志采用 progressive disclosure，普通 conversation 状态继续克制。

## 本版延期

- Browser computer-use、浏览器自动化与登录 session 控制。
- Connectors、MCP/plugins 与通用外部应用命令。
- 后台任务与关闭窗口后的 agent 执行。
- Vector memory、多 Agent、Tempest 与 SwiftUI 替换。
- Directory-tree operations、任意文件类型编辑、超限文件、任意网页 MIME/encoding。

## 最终验收状态

| 验收层 | 结果 | 证据与边界 |
| --- | --- | --- |
| 离线 unit / integration | 296 pass，1496 assertions，全部原 v0.1 回归保留 | `output/v02-validation/unit-final.log`；typecheck / lint / format / security audit 全通过 |
| 生产构建 Electron E2E | 12 pass，54.7 秒 | `output/v02-validation/e2e-final.log`；原 6 项加 v0.2 6 项 |
| 真实模型 / Brave / public page 服务 | 未运行，0 次真实服务调用 | 本轮无额外授权；TLS transport 在 Web E2E 中被替换，不宣称真实服务或 TLS handshake 成功 |
| 最终签名包 | macOS arm64 v0.2.0，本地 ad-hoc 验签通过；7 项 packaged E2E 全通过 | `output/v02-validation/e2e-packaged.log` / `artifact-proof.json`；六个生产资源与最终 build 逐字节相同，不含测试入口；没有 Developer ID / notarization |
| 实机 UI 代操作 | 设置、Cmd+N/K/,、侧栏、native folder picker 的取消、context menu、fullscreen、native Quit 已操作并观察 | 本次最终签名包与隔离 profile；没有真实 key 或服务调用 |
| 完整人工 native 验收 | 未完成 | 真人 VoiceOver、物理 trackpad/resize、系统 Reduce Motion 切换与真实 Finder/Trash 结果仍未验收；不能用 API/E2E 替代 |

完整证据、复现方式和剩余验证范围见 [V02-VALIDATION](V02-VALIDATION.md)。源码保持 UNSTAGED、UNCOMMITTED、UNPUSHED；未执行 add/commit/push。
