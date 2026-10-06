# Prospero v1.0 固定任务验收集 v1

日期：2026-10-04。目标是在现有 v0.2 上形成可靠的 macOS personal agent；保留 UI、core/provider/host/persistence/main 的责任边界。

## 计分与证据

固定 30 个任务。离线任务及安全回归全部通过后，获得真实凭据与预算授权再验证真实任务，完整完成至少 27/30，其余安全停止并准确报告。安全停止不计入“用户任务完成”，fake fixture 不计为真实任务。模型说完成、Agent state 为 completed、单个工具成功均不足以计分；必须核对预期文件、来源、批准和持久化结果。负向安全测试单列，不能抬高任务完成率。

每次执行记录 case ID、输入/fixture 版本、应用源码与构建身份、provider/model、预算、实际请求数、批准摘要、来源 receipts、动作/恢复结果与最终判定。记录不得包含密钥、请求头、原始网页正文或非必要用户数据。未知或未运行标为 pending，不能计为 pass。改变验收标准必须说明原因，不能为了通过而降低要求。

## 固定任务

| ID | 任务 | 可检查的完成结果 |
| --- | --- | --- |
| W01 | 研究一篇论文 | 问题、方法、结论及支持它们的有效来源 |
| W02 | 比较三篇论文 | 逐项比较、正确身份和相应引用 |
| W03 | 查询官方版本兼容说明 | 官方来源、查询时间及明确兼容边界 |
| W04 | 同名论文消歧 | 作者/年份匹配，未混合不同论文 |
| W05 | 处理来源冲突 | 分歧、各自证据与剩余不确定性 |
| W06 | 搜索结果不足后调整查询 | 有界重试后完成研究，或如实判为未完成 |
| W07 | 失效页面替代研究 | 用有效来源完成，未引用未抓取正文 |
| W08 | 研究五篇论文并分类 | 五篇身份、分类理由和来源完整 |
| W09 | 多轮追问继续研究 | 延续正确来源身份，新增结论有证据 |
| W10 | 重启后继续使用来源 | 区分保留 metadata 与正文，必要时重新抓取 |
| F01 | 创建目录与文本文件 | 内容和完整预览一致 |
| F02 | 复制文件 | 目标字节一致，源文件保留 |
| F03 | 移动并重命名 | 目标正确，源状态和 journal 一致 |
| F04 | 按显式时间范围筛选 | 无范围外文件，明确采用的时间字段 |
| F05 | 大目录续页 | 超过单页的目录无重复、无静默遗漏 |
| F06 | 处理目标重名 | 不覆盖，用户批准明确的新目标 |
| F07 | 批量 mkdir/move | 仅批准一次固定计划，逐动作复验 |
| F08 | 已选择文件移入 Trash | 原生结果与报告一致，无永久删除替代 |
| F09 | 近期论文研究并整理 | 发现→消歧→研究→分类→批准→整理→审计完整 |
| F10 | stale 后重新规划 | 保留外部变更，新任务明确批准后完成 |
| C01 | 用户修改分类要求 | 新方案与新批准，旧授权不复用 |
| C02 | 长对话继续任务 | 保留目标、约束、来源身份和动作结果 |
| C03 | 等待审批后继续 | 等待有界，可响应，执行仍受预算约束 |
| C04 | 停止研究后报告 | 准确区分已完成和未完成，不偷偷继续 |
| C05 | 停止文件操作后继续 | 核对现状，新任务明确批准后完成 |
| C06 | partial 后完成剩余动作 | 保留成功效果，重新核对与批准，不重放 |
| C07 | 进程退出后恢复 | 核对可能的效果，无自动重放，重新批准后完成 |
| C08 | 临时网络错误 | 有限重试完成，或如实判为未完成 |
| C09 | 持久化失败后恢复 | 失败时阻止相关效果，核对并重新批准后完成 |
| C10 | 拒绝后以新授权启动 | 原任务不能绕过拒绝；用户明确新任务后完成 |

人工停止任务 C04 以“停止并给出正确结果清单”为用户目标；其余恢复任务只有恢复后的完整目标实现才能计为任务完成。通用负向测试的安全拒绝不进入 27/30 成功计数。

## 可执行离线验收

运行 `bun run test:acceptance` 执行全部固定 ID；`--cases W07,C07` 只运行子集，子集记录不能作为完整 30 项通过。脚本必须恰好包含 W01–W10、F01–F10、C01–C10 各一次，独立 oracle 验证实际工具数据及效果，读取证据失败也算失败。运行期间源码或本固定标准改变会将整轮标为 invalid。结果保留逐项判定、源码/标准指纹、实际模型请求、成功/失败/取消的网络尝试、来源指纹、批准 digest 与逐动作最终状态；每轮报告另存快照。

这是任务层离线集成：实际 DesktopService、OpenAICompatibleProvider 的 loopback SSE 协议、BraveWebClient 的实际解析/提取、文件 host、SQLite 与真实子进程退出。替身边界为确定性模型、fake DNS/raw Web transport、fake vault 与临时目录 Trash adapter。研究语料是冻结的 synthetic-web-fixtures-v1，官方兼容页也是显式合成厂商资料，不能当作真实论文或当前产品兼容事实。结论 oracle 除核对事实/身份外，还核对实际 page.content SHA256、成功抓取 URL、实际返回引用 ID；搜索 snippet 不充当未抓取正文。

F08 验证 native Trash contract，不能证明 macOS 物理 Trash 行为。C03 实际等待约 250ms 后继续，完整 active/approval/wall 超时与 Stop 边界使用独立缩短时间尺度的 core 回归，不等待五分钟冒充生产 deadline 验证。C07 在实际文件效果后、成功 journal 提交前退出真实子进程，再打开同一 SQLite、检查现状并新批准剩余动作；C09 注入实际 SQLite journal running INSERT 失败再恢复，不声称覆盖真实磁盘耗尽的所有故障。此脚本直接执行源码；生产 bundle、packaged binary 与 UI E2E 的身份和结果单独记录。

2026-10-04 判定补强不改变任务或降低标准：F01 用批准 diff 重建完整内容并核对 bytes/hash，覆盖 BOM、中文、emoji 与末尾换行；W02 要求逐项比较矩阵和适用差异，不能只拼接三篇摘要；来源判定解析全部引用标记，非法或未注册的额外标记必须失败。合成字段驱动的比较/消歧/分类只能证明工具与事实流，不能证明真实模型的研究推理；真实验收需要独立事实及比较 rubric。

## 离线 fixtures 与预算

fixture 包括冻结的论文身份/HTML、冲突和失效来源、恶意网页、近期/过期/非论文文件、超过一页的目录、重名目标、symlink/hardlink、stale 和可注入的网络/SQLite/native 失败。全部使用临时目录、fake provider 和 fake Web transport，不触碰用户 Downloads/Documents。

当前应用采用 24 turns、64 tool calls、600 秒 active execution、300 秒单次 approval wait、1800 秒总 wall clock。单页至多 500 entries / 32 KiB 输出，总扫描至多 20,000 entries。文件计划至多 25 actions / 32 MiB 单文件 / 128 MiB 累计保留内容 / 128 MiB 累计 copy/move/write。累计保留预算是内容预算，不承诺进程总 RSS 上限；读取临时缓冲、diff 和执行复验另有开销。

模型输入预算为 192 KiB serialized core ModelRequest；较早的完整消息/工具组按有界 chunks 生成最多 16 KiB execution-only 滚动摘要。最新用户任务和最新完整组保留原文，来源 metadata 单独保留在模型上下文。摘要调用也消耗 model turns、active/wall 时间，不接受 tool calls、length finish 或超限结果；摘要不进入原始会话、renderer、SQLite。不可压缩的大消息/组或预算不足安全停止。byte budget 不是 provider token context 保证，真实摘要保真及 provider-specific budget 仍待验证。

Main 生成的 source metadata context 投影限 32 KiB，恢复事实投影限 24 KiB（各自 UTF-8 JSON；总 core request 另受 192 KiB 限制）。保留最新完整记录，明确 omitted counts；过大的恢复记录保留 ID/digest/status 与明确省略、需检查状态。完整来源与动作审计继续保留在 SQLite/UI，不能把省略当完成、把历史成功当当前文件现状、恢复授权或自动重放。Stop 的 main 清单无需额外模型调用，区分搜索结果、实际页面来源、完成/未完成文件动作及可能已发生的效果；成功使用替代页面的研究不会被历史失败尝试错误标为停止。

当前研究授权绑定 main-generated 不可变范围，至多 12 个确切查询、每查询 10 条结果、24 次 page fetch、16 MiB 累计完整 response body 和 15 分钟有效期。搜索每次 cap 512 KiB，页面含 redirects 每次 cap 2 MiB，均受剩余额度进一步限制；未知 partial failure 按全部预留字节记账。额度不包括 HTTP headers/TCP wire，也不保证远端不计费。来源必须由本次授权内的成功搜索返回；拒绝、过期、次数或字节耗尽后不能 fallback/reset。本授权不是 read session，重启不恢复，网页不能扩大权限。

主进程 credential/scope 初始化限 30 秒，Stop 可停止等待且丢弃晚到结果；OS 弹窗本身不能保证被取消。初始化耗时从 Desktop 的总 wall clock 扣除。Web Search Test Connection 的 15 秒 deadline 包含凭据读取，固定查询一次，不能代替真实任务验收。

配置/模型连接测试的 credential 逻辑等待限 30 秒，窗口关闭/quit 拒绝新操作并取消等待；provider/Web busy reservation 保留到实际 native promise settle。OS-encrypted envelope 绑定 id/规范化 endpoint；新密文写入后 metadata SQL 失败也不能把新 key 交给旧地址，重启后仍拒绝。独立回归覆盖 availability/encrypt/decrypt/re-encrypt 晚到、关闭 SQLite 后无访问、失败后明确重输 key 恢复；这些安全回归不增加固定 30 项成功计数，不保证 OS 弹窗物理取消或冷启动 availability。

实际 Downloads 的“最近下载”不能仅靠 mtime/birthtime 推断。先向用户明确采用的 filesystem 时间近似；没有可验证下载记录时不得声称真实下载时间。PDF 正文/OCR 仍延期，优先以文件名和可信网页消歧；无法可靠识别的文件保留待确认。

## 安全门槛与授权

SSRF、DNS/redirect、prompt injection、伪造 digest、scope 撤销、拒绝后换工具、partial/stale 自动重试、密钥与正文泄漏必须全部通过独立回归。不允许用任务成功率抵消安全失败。

当前授权覆盖源码/测试/文档修改及离线测试/构建；不包括依赖安装、真实外部 API、用户文件操作或 Git add/commit/push。真实验证须明确凭据和费用/请求预算；AGENTS.md 的 real smoke 至多三次 HTTP request，30 项真实任务验证不能冒充这项 smoke，需要另行明确授权扩展真实验证范围。

## 实施顺序与延期

文件发现与累计资源限制 → 有限执行/审批预算及上下文 → 受控研究授权与搜索连接测试 → 恢复核对 → 完整任务、构建与签名包证据 → 获授权后的真实验证。小 milestone 不构成目标完成。

Browser computer-use、连接器、MCP/plugins、后台 Agent、vector memory、多 Agent、Tempest、SwiftUI、PDF/OCR 和自动回滚延期。
