# Dots 架构、Domain 与持久化 — M001 / M002 / M003

2026-10-19：当前实现与证据见 [DOTS-DELIVERY](DOTS-DELIVERY.md)。以下 M001–M003 是历史基线。当前 schema v9；startup recovery、共享 admission、checkpoint、有限 runner、Dots UI、core suspension、durable approval 与正式 Web 研究已接入。跨 Run 可撤销 policy / 累计 reservation 见 [ADR-011](decisions/ADR-011-repeat-research-policy.md)，仍复用同一个 core runner。关闭窗口可继续，Quit 停止；绑定原授权的一次性 wake、原子 claim/Run/model reservation、重启与无窗口调度见 [ADR-012](decisions/ADR-012-durable-one-shot-wake.md)。明确的 unknown review、Dot/review 原子 revision 推进和跨 Run 请求历史见 [ADR-013](decisions/ADR-013-uncertainty-review-and-request-history.md)。持久监督列表、原生提醒 attempt claim 与只读点击路由见 [ADR-014](decisions/ADR-014-supervision-inbox-and-native-alerts.md)。终态 Run/partial-work context 的 read transaction、模型内部历史工具与同源只读 UI 见 [ADR-015](decisions/ADR-015-durable-cross-run-context.md)，仍使用 schema v9。完整长期 memory/context、artifact、planning/proactive 等继续实施，完整目标未完成。

M001 日期：2026-10-06（Asia/Shanghai）。M002 更新：2026-10-07。M003 更新：2026-10-08。状态：**M002 纯 domain/lifecycle 与 M003 Durable Dot/Run Repository 已实现并通过离线验证。当前成熟度仅为 Level 1 — Durable，不代表恢复、执行、调度或自治已实现。**

M001 完成 Repository / Architecture Discovery，并停止于 commit `62d1f9c`；M002 完成纯 domain，commit 为 `50bb182f349fef070b3a47f8c77047c25b066412`。用户随后批准重新拆分的 M003–M016 路线，本轮仅授权 M003 Durable Dot/Run Repository。后续 recovery/runtime/approval/wake/UI 仍为提案；M003 结束后停止，不自动进入 M004。

## 1. 仓库与证据基线

| 项目 | 实际发现 |
| --- | --- |
| 聊天工作目录 | `/Users/chadrayfoo/Documents/ChatGPT/prospero`；只有 `.git`，`master` 尚无 commit，也无源码 |
| 实际源码仓库 | `/Users/chadrayfoo/Projects/prospero` |
| 开始 branch / HEAD | `main` / `a35400d0f006c08ccf3fc4c2c6e52c8fd87b431c` |
| 开始工作区 | `git status --short`、unstaged/staged diff 均为空 |
| M001 工作分支 | `codex/dots-architecture` |
| package manager / runtime | `packageManager=bun@1.4.2`；本机 Bun `1.4.2`、Node `v24.14.0` |
| 应用版本 | root 与 desktop `package.json` 均为 `0.2.0`；Electron dependency `44.5.1` |
| workspace | Bun workspaces：`apps/desktop`、`packages/*`；不是另一个 Tempest monorepo |

`AGENTS.md` 要求保持 `core → nobody`，不创建 Tempest/shared/common/utils package，不修改 Ariel，renderer 不访问 privileged APIs，write/shell 由 main 批准。它默认禁止提交，但用户本次明确要求每个 milestone 独立 commit，因此 M001 只提交本提案及导航文档，不推送。

历史笔记用于定位代码；上表保留 M001 开始时的基线，M002/M003 结论按各阶段实际源码复核。旧文档中的“未 commit/push”或早期 schema 描述不能代替当前 Git 与源码事实。`docs/V1-VALIDATION.md` 是既有验证记录，不能算作 M001 重新执行的测试；它仍明确固定真实任务为 `0/30, pending`。

## 2. 当前系统结构

```text
apps/desktop React renderer
  → DesktopBridge / preload allowlist
  → sender/frame/argument-validated IPC
  → DesktopService（Electron main 的 application composition）
      ├─ @prospero/core.runAgent
      │    ├─ ModelPort → @prospero/providers
      │    ├─ ToolHost → @prospero/local-host + @prospero/tools
      │    │              └─ main/web-tools → @prospero/web
      │    └─ PermissionPort → main-owned approval
      ├─ @prospero/persistence.ProsperoStore（node:sqlite）
      └─ CredentialVault / native desktop adapters
```

| 当前 owner | 已有能力 | Dots 可复用与边界 |
| --- | --- | --- |
| `packages/core` | messages、固定 system policy、有限 model/tool loop、effects、权限语义、context budget、cancel/cleanup | 继续作为执行 runtime；不放 Dot identity、DB 或 timers |
| `packages/dots` | M002 纯 identity/goal、Dot/Run lifecycle、in-flight/reference/revision guards；M003 增加可信 rehydration | 保持零运行依赖；不访问 DB，也不接产品 execution |
| `packages/providers` | OpenAI-compatible model adapter、bounded stream、连接测试、endpoint policy | 复用 `ModelPort`；不让 provider 管理 wake 或 Dot status |
| `packages/tools` | host-neutral metadata、参数校验、资源上限 | 复用工具定义与解析；不能让模型提交任意宿主能力 |
| `packages/local-host` | multi-root scopes、文件 discovery/read、结构化 Action Plan、stale 检查、shell cleanup | 复用 prepare/execute 和 journal；shell cwd 仍不是 OS sandbox |
| `packages/web` | Brave/Tavily search、安全 public HTTPS fetch、地址校验、正文提取、source receipts | 复用 transport；研究授权目前在 main 且绑定 conversation/run |
| `packages/persistence` | 既有 schema v2、SQLite WAL、conversations、executions、Action Plans/journal、来源 metadata、密文凭据；M003 增加 schema v3 Dot/Run repository | persistence → dots；普通 Dot read 不执行恢复，尚未接入产品 runner |
| `apps/desktop/src/main` | composition、凭据 reservation、审批、恢复报告、native adapters、窗口/退出生命周期 | Dots runner、scheduler adapter 与全局执行 admission 的落点 |
| renderer | task/conversation sidebar、timeline、approval previews、Sources、Settings、显式 Memory | 增加独立 Dots views/store；保持现有 conversation flow |

### Chat、Tasks、Memory、Computer 的真实含义

- 当前 `New task` 创建的是 `Conversation`；`sendTask(conversationId, text)` 启动一次 execution。没有独立的 persistent Goal/Task workflow aggregate。DotTask 应表示 Dot 内计划工作项，不能复用 UI task 名称推断已有实体。
- `Conversation` 是交互和展示记录，`ExecutionRecord` 是一次 conversation-bound 执行摘要。二者都不承担长期 agent identity。
- 显式 Memory 是 `Settings.memory: MemoryEntry[]`；`ContextWindow` 的滚动摘要仅在本次 execution 内存在。它们均不是 Dot 的长期 checkpoint。
- Computer 当前包括受 scope 约束的文件操作、逐命令批准且具有完整 OS 用户权限的 shell、Finder/clipboard/Trash 等 native adapters；没有通用浏览器 click/type 或 computer-use runtime。
- M002 已有独立 Dot/Run domain，M003 只接仓储，不接产品 runner/UI；没有 checkpoint、scheduler、持久 wakeup、approval 或独立后台 worker。`DesktopService.timers` 是 32 ms UI stream batching。

### 当前执行与恢复约束

`runAgent()` 已经有有限 loop：默认 12 model turns、32 tool calls、180 s active、300 s 单次审批、900 s wall clock。Desktop 显式配置 24/64、600/300/1800 s，并把 credential/scope 初始化时间计入总 wall clock。不要为 Dots 另写一个无限 LLM loop。

`AgentOutcome` 只有 `completed | failed | cancelled`。其中 `completed` 表示本次模型回复没有继续请求工具，**不证明长期 goal 已达成**。目前没有 sleep/continue/checkpoint/suspended outcome，也没有可序列化的 pending execution。

当前同时只允许一个 active task，初始化前已预留 execution；provider/Web 配置与 native credential 操作另有 reservation。Dots 接入必须延续这些排他语义。

既有 Chat 重启处理通过 `interruptExecutions()`、`recoverActionPlans()` 和 main recovery 标记 interrupted、补齐 tool history、生成事实报告；不重放工具、不恢复 grants。M003 Dot repository 重开与普通 read 保留实际保存的 pending/running 状态，不释放 pointer，不标 interrupted；独立 Dot Startup Recovery 属于 M004。

最后窗口关闭会 `suspendWindow() → shutdown()`，取消全部 active execution；macOS 留下的是空闲 App。renderer crash 也触发 shutdown。Cmd+Q 等待 cleanup、关闭 SQLite、退出进程。当前并不存在“关窗口继续工作”。

## 3. 架构决定

### AD-DOTS-001：新增独立 orchestration owner，保留当前 runtime

M002 新增 `@prospero/dots`，目前仅负责纯 Dot/Run domain 与 lifecycle commands，零依赖。它不依赖 React、Electron、Node I/O、具体数据库、provider wire protocol 或 timer 实现。未来 application ports 按实际需要增加，runtime adapter 放在 main；core 永不反向依赖 dots。

```text
renderer Dots UI → typed IPC → main DotManager composition
                                ├─ @prospero/dots
                                │    ├─ DotStorePort → persistence SQLite adapter
                                │    ├─ DotRuntimePort → main adapter → core.runAgent
                                │    └─ clock / wake ports → main scheduler adapter
                                └─ shared execution admission + current credential/host policy
```

依赖方向：`desktop → dots/core/providers/local-host/web/persistence`；`persistence → dots/core` 只用于实现明确的存储 contracts；`dots → core` 至多使用执行 contracts；保持 `core → nobody`。禁止泛化为 shared/common 或提前提取 Tempest。

本需求中的“Tempest Runtime”在本仓库应暂时映射为 `@prospero/core` 与 main 组合的执行 adapters。未来只有真实共用边界验证后才评估提取；DotRuntimePort 是稳定替换接缝，不是新 runtime 实现。

### AD-DOTS-002：Dot 独立于 Conversation、cron 与单次 run

Dot 的 `id`、goal、status、checkpoint、wake 和审计都以 Dot 为归属。可记录可选的 conversation link，方便用户对话；删除/关闭 conversation 不删除 Dot。不要创建隐藏 Conversation 充当 Dot 的唯一 persistence owner。

Trigger 是唤醒原因；Schedule 是其中一种配置；DotRun 是处理一次唤醒的有限尝试。Cron 不进入核心模型，首版仅支持 manual 和绝对时间的 one-shot wake。

### AD-DOTS-003：先确立合法状态，再接 persistence 与 execution

原建议把 state machine 放在 M005 太晚。M002 明确分离 `DotLifecycleStatus` 与 `DotRunStatus`，通过纯 domain commands 校验转换；M003 再落盘同一模型。waiting/schedule/approval 属于后续 orchestration 条件，不能混进长期 lifecycle。

### AD-DOTS-008：M002 的最终 Domain Decisions

M002 开始于 `codex/dots-architecture` / `62d1f9c`，工作区 clean；在 `codex/dots-domain-lifecycle` 实施。以下选择在写代码前确定：

- Dot 长期 lifecycle 为 `active | paused | completed | cancelled | archived`；Run status 为 `pending | running | succeeded | failed | cancelled | interrupted`。单次 Run 的失败/中断/取消不改变 Dot 长期 lifecycle，也不自动重试。
- Dot 仅包含 stable branded ID、name、一个 first-class readonly `DotGoal { text }`、lifecycle、创建/更新时间、revision 与可选 `inFlightRunId`。Goal 在本阶段固定；不增加独立 goal ID/revision、description 或尚无语义的配置字段。
- DotRun 有自己的 branded ID、dotId、status、创建/更新时间及与状态对应的 start/finish 时间。`pending` 无 start/finish，`running` 有 start；成功/失败必须已 start，取消/中断可以发生在 start 前。`dotRevision` 与配套 Dot 快照对齐，拒绝同 ID、同毫秒下仍引用旧阶段的 Run 快照。
- `createDotRun/startDotRun/finishDotRun` 同步返回新的 `{ dot, run }`，pending 和 running 都占用同一个 in-flight pointer。匹配 owner/current pointer 才能 start/finish；历史或外属 Run 不能释放新 Run 的位置。
- 纯 `pauseDot/resumeDot/completeDot/cancelDot/archiveDot` 遇到 in-flight 都拒绝；domain 不假装 tool cleanup 已完成。未来 application 先封 admission、abort/await、settle Run，再提交最终 lifecycle。M002 不实现停止意图、控制器或实际 abort。
- 宿主显式传入 ID 和 epoch-ms time，未来沿用项目的 `randomUUID` 发号；domain 不读时钟、不依赖 Node。ID/text/time 有界校验，允许同一毫秒的合法转换，拒绝时间倒退。每个有效 aggregate 变化递增 revision。
- readonly 且 frozen 的新快照不修改输入。错误沿现有 typed Error 风格，用 `DotError.code` 区分 `invalid-input / invalid-transition / invalid-reference / run-in-flight`，固定文案不回显输入。
- `@prospero/dots` 单一 public entry，零运行依赖。不调用 `core.runAgent`，不提前定义 Store/Runtime/Clock/wake ports、get/list repository API 或 fake repository。M003 才承担 persistence、全局 ID uniqueness 与 CAS；单个最新快照的占位约束不等于跨进程 concurrency guarantee。

### AD-DOTS-004：保存意图与结果，恢复事实，不自动重放效果

claim、run creation、关键 event 与 revision 必须先原子提交，才启动 runtime；效果前 journal/authorization 必须 commit 成功。最终 outcome、checkpoint、Dot status、next wake 与 run finish 也原子提交。

`runAgent.onEvent` 当前是 presentation observer，其异常被 core 吞掉；不能把它当作持久化成功屏障。Dots 的 journal、审批、dispatch 和最终提交通过 authoritative ports 处理，持久化失败必须阻止后续效果并取消 invocation。普通 text deltas 可 batch，关键生命周期不可依赖 renderer 收到事件。

### AD-DOTS-005：MVP 全局执行并发仍为 1

Chat 与 Dot 将在 M005 共用 main-owned execution admission，不能新开互不知情的 active map。先证明 acquire/release 与初始化取消的单执行语义；M014 再按 scheduler 的实际需要接有界等待与 due 排序。已运行工作不被无提示抢占，busy wake 保持 durable pending，重复 wake 使用稳定 ID 去重。

provider/Web reservation、scope capture、配置修改互斥和初始化取消仍由 main 执行。进程 single-instance lock 不能代替数据库里的 revision/claim 检查。

### AD-DOTS-006：自动唤醒与授权分别校验

Goal、schedule、checkpoint、模型输出都不构成工具授权。当前 network search/fetch 仍需研究批准，write/shell 仍需 main-owned preview 与批准，read 仍受选定 scope 和 `askBeforeReads` 约束。

拒绝与不确定效果形成 **Dot-level durable gate**：不能下一次 run 重建 deny ledger 后再次尝试相同效果，也不能由 timer 自动“新 task 再问”。拒绝后只允许无该效果的安全重规划，或由用户显式修改/解除 gate；scheduled wake 不弹出重复相同批准来绕过拒绝。

### AD-DOTS-007：窗口是观察入口，进程是本地执行宿主

MVP 将 Chat window suspension 与 Dot app lifetime 分开。切换页面或关闭窗口不销毁 Dot；macOS App process 活着时，已允许的有限 Dot 工作可以继续。没有窗口时遇到 approval/user input，持久保存等待状态并结束 invocation。

Cmd+Q 仍真正退出，停止 admission/timers、取消并等待 tool/native cleanup、提交状态后关闭 DB。首版不安装 LaunchAgent/daemon，不承诺进程退出或机器睡眠期间准点执行；下次启动/系统恢复时处理 overdue wake。非 macOS 关闭最后窗口目前会退出，也按此边界处理。

## 4. Domain model 与后续实体

以下区分 M002 已实现的最小实体与后续提案；没有一次建立十二套 repository。

| 实体 | 初步职责与关键字段 | 首次落地 |
| --- | --- | --- |
| `Dot` | M002 已实现：stable `id`、name、goal、`lifecycle`、`revision`、createdAt/updatedAt、可选 inFlightRunId；不含未来配置与 checkpoint | M002 |
| `DotGoal` | M002 已实现：first-class readonly `{ text }`，嵌入 Dot；整个 lifetime 固定，不等于当前 prompt，不单独复制 lifecycle | M002 |
| `DotTask` | M006 先表达有界的当前工作项、已完成/待做事实；完整 task graph/planner 独立扩展 | M006 最小 progression；完整能力 post-MVP |
| `DotRun` | M002 已实现：`id/dotId/dotRevision/status`、createdAt/updatedAt、状态对应的 startedAt/finishedAt；没有 runtime、wake 或 artifact payload | M002 |
| `DotEvent` | 根据实际 run/approval/dispatch 审计需要增加 observable records，不提前建立通用事件系统 | M007/M009 按需；M003 不实现 |
| `DotCheckpoint` | 有界事实、工作位置、notes/result refs、schema version 与来源 run；不是进程快照 | M006 |
| `DotTrigger` | 先实现 manual/time wake intent 与稳定 ID，再按真实需求扩展 event/dependency | M012；通用 triggers post-MVP |
| `DotSchedule` | 一次绝对 UTC wake；展示采用用户 timezone；不先引入 cron | M012 intent，M014 driver |
| `DotApproval` | pending intent、不可变 preview/digest、身份/preconditions/expiry、decision/consumption/dispatch facts | M009 |
| `DotPermission` | main-owned scopes、effect-specific gates；独立的有限 repeat-research policy，不包含 key | M009/M010 授权接线，M011 repeat policy |
| `DotMemory / DotContext` | 从有界 checkpoint 起步；不保存全部网页，不把全历史塞入 context | M006 最小 context；完整 memory post-MVP |
| `DotArtifact` | 先保存可检查的内部结果；真实研究结果须绑定实际来源与 receipt | M006/M007 内部结果，M010/M016 研究证据 |

`lastRunAt`、`nextWakeAt`、`currentActivity` 可以是查询投影，但其原始事实来自已提交 run/wake/events；缓存必须和 aggregate revision 对齐。所有 public DTO 都是最小可观察数据，不含 credential、PreparedTool 或私有推理。

### 最小 application API

M002 public commands：`createDot/pauseDot/resumeDot/completeDot/cancelDot/archiveDot`，以及 `createDotRun/startDotRun/finishDotRun`。只导出必要的 entity/ID/status/change types、status constants 和 `DotError`；validation/snapshot helpers 不在 public entry 导出。

M003 为存储增加纯 `rehydrateDot(unknown)` / `rehydrateDotRun(unknown)` public contract：验证允许字段、ID/state/time/revision 与状态对应的时间字段，拒绝 extra fields，返回独立 frozen 快照。Repository 再验证列/payload、owner 与当前 pair。读取不是 `JSON.parse(...) as Dot`，也不通过重放历史转换重建当前状态。

`ProsperoStore.dots()` 返回独立 repository，提供 `create/get/list/transition/createRun/startRun/finishRun/getRun/runs`。这些操作使用 domain commands；没有任意 save/upsert、goal 编辑或 hard-delete。consumer 在所属 package 声明 `@prospero/dots: workspace:*`；M003 不为未接线能力增加 desktop 产品 dependency。

`get/getRun` 对不存在的 identity 返回 `undefined`；需已有 Dot/Run 的 command 和 `runs` 则抛出 typed `not-found`。`list/runs` 按 `(createdAt, id)` 排序，默认 `limit=50 / offset=0`，limit 范围为 `1..200`；`list` 默认 `includeArchived=true`。这些查询返回 frozen 快照与数组。

M002 `pauseDot` 只接受无 in-flight 的 active Dot。它不 abort、不停止 OS 进程；future application stop/pause 必须先阻止 admission、等待实际 cleanup、结束 Run，再调用该纯转换。`finishDotRun(..., 'cancelled', ...)` 仅取消本次 Run，`cancelDot` 才取消长期目标。archive 保留 domain identity，future store 保留 history。

### 后续 orchestration ports（M003 不实现）

| Port | 必需语义 |
| --- | --- |
| storage extension | 在 M003 repository 上按 milestone 增加 recovery、checkpoint、approval、wake 的明确原子操作，不能通用任意 overwrite |
| `DotRuntimePort` | 单次有限 invoke，接受 host-built goal/context、预算、AbortSignal 与运行身份，返回 typed outcome 和待校验 continuation proposal；不调度自身 |
| `ClockPort` | wall-clock UTC milliseconds；允许 fake clock；运行 elapsed budget 用 monotonic clock，不被墙钟回拨补充额度 |
| `WakeDriverPort` | 主机激活下一次检查、取消检查、通知时间已到；DB wake 是 source of truth，timer handle 不持久化 |

Store 不能只暴露松散 `saveDot()`、`saveRun()` 然后靠调用者猜测原子性。运行 claim 使用 dot revision、wake ID、run ID/generation 与 SQL 唯一约束；过时/晚到 callbacks 不能提交到新的 run。

## 5. 生命周期与一次 run

### Dot 与 Run 分别建模

M002 采用两个独立维度，取代 M001 将 execution/wait/lifecycle 混合的 `DotStatus` 提案。Dot 一经创建即 `active`；其 identity 和 goal 不随 Run 更新。

| Dot command | 合法来源 → 目标 | guard |
| --- | --- | --- |
| pauseDot | active → paused | 无 pending/running Run |
| resumeDot | paused → active | 无 in-flight Run |
| completeDot | active/paused → completed | 显式长期完成命令；无 in-flight Run |
| cancelDot | active/paused → cancelled | 显式长期取消命令；无 in-flight Run |
| archiveDot | active/paused/completed/cancelled → archived | 无 in-flight Run；本阶段永久归档，不提供 unarchive |

重复转换与其他组合全部拒绝；completed/cancelled/archived Dot 不再创建 Run，也不能 resume。completed/cancelled 仍可归档。completed 是否满足真实 goal 由未来 application 的结果校验负责，本阶段只证明显式状态转换。

| Run command | 合法来源 → 目标 | aggregate 变化 |
| --- | --- | --- |
| createDotRun | 新 Run → pending | Dot 必须 active 且空位；保留 Dot identity/goal，预留 inFlightRunId |
| startDotRun | pending → running | 验证 owner/pointer/dotRevision/time，记录 startedAt，递增对应 Dot revision |
| finishDotRun | running → succeeded/failed/cancelled/interrupted | 记录 finishedAt，释放 pointer；Dot lifecycle 保持 active |
| finishDotRun | pending → cancelled/interrupted | 尚未开始的取消或中断，无伪造 startedAt；释放 pointer |

Run 终态不接受 restart 或再次结束；Run 成功不等于 Dot completed，Run 失败/中断不等于 Dot failed。`dotRevision` 在两个返回快照中匹配，旧阶段、外属 Run 或旧 Run 不得结束新的 in-flight。revision 是纯快照版本，不是数据库锁；M003 仍须 CAS/唯一约束阻止陈旧 aggregate 分叉。

### Wake / Block reason 属于后续 orchestration

active Dot 可以暂时因为 schedule、approval、user input 或 recovery 而没有 Run；这些将以独立、有界、typed 条件建模，本阶段不预先增加字段/enum。未来 UI 的 SLEEPING/NEEDS_APPROVAL 等是可观察投影，不是 M002 的永久 lifecycle。

future claim 必须满足 lifecycle active、无 in-flight、wake eligible、无控制/recovery 阻断；effect-specific denial 继续限制 host，但允许无被拒效果的安全重规划。due 只标 eligible，成功 admission 后才原子 claim/create/start；WAIT/睡眠/审批挂起结束本次 invocation，释放 slot，并保存独立条件。具体 runtime suspension primitive 留在 M008，exact intent resume 留在 M009，不能用 cancelled/denied 假装 suspended。

M004 的后续恢复必须先取得明确的 exclusive owner，再原子结束遗留 in-flight 为 interrupted 并维护对应 Dot pointer/revision；它不能中断另一个活跃 owner 的 Run。以后接入效果后，未知结果保留 recovery gate，不能因 Dot 仍 active 就自动重放。M003 不实现这项启动行为。

### 一次有限 run 的事务顺序

1. 验证 Dot/goal/policy revision、scope identity、provider availability、denial/recovery gates，获得共享 admission。
2. 原子 claim wake，创建/启动 DotRun 并保存对应 Dot pointer/revision、run-start event；Dot lifecycle 仍 active，提交失败时不读取凭据、不请求模型。
3. main 在既有 credential reservation 中初始化 adapters；context 来自有限 checkpoint、明确 goal、task/notes 和必要来源 metadata。
4. 调用当前 core runtime；继续用同一预算、AbortSignal、host prepare/execute、permission 与 effect journal。
5. runtime 结束后，由 main 校验 `DotStepProposal`：`CONTINUE / WAIT / SLEEP / REQUEST_APPROVAL / REQUEST_USER_INPUT / COMPLETE / FAIL`。模型只能提出下一步，不能更改授权、直接设置状态或发 timers。
6. 原子写 run outcome、checkpoint、artifact refs、events、Dot status 和 wake；提交成功才发布 UI 并安排下一次 timer。
7. 释放 admission；CONTINUE 通过新 wake/queue 且受连续次数、累计预算与最小间隔限制。停止、无进展或预算耗尽进入可观察等待，不反复“新 run 重置额度”。

M006 先建立最小 durable progression，包含已完成/待做事实、工作位置和有界 notes/result refs；M007 runner 必须消费已提交 checkpoint，不能每次只读取 goal。可以通过严格校验的 application control tool 表达 continuation proposal；它不直接调用 DB/timer。具体 schema/终止门控在 runner 阶段验证，不能匹配 assistant prose 猜测完成，也不需要新的 provider structured-output 协议。

M007 首先只开放内部结果和明确 scope 的读取能力，通过正式 application/service 接口完成一次有限 Run，并证明后续 Run 消费上次 checkpoint。M009 接 durable approval，M010 接 Dot-owned bounded research；write/shell 仍受独立的已有权限边界约束，不因研究 policy 自动开放。fake 研究材料只证明 continuation，不冒充真实联网研究。

## 6. M003 Durable Dot/Run Repository

本阶段的唯一目标是将已有 Dot/Run domain state 原子保存到 SQLite，并在独立进程重新读取。仓储属于 `@prospero/persistence`，通过 public entry 使用 `@prospero/dots`；domain 不反向依赖 SQLite、Node、Bun DB、Electron 或 provider。M003 不接启动恢复、runtime、events、checkpoint、memory、wake、approval 或 UI。

### Schema 与兼容性

在现有 `ProsperoStore` 中将 schema v2 升级为 v3，仅新增独立 `dots` / `dot_runs`。Dot 与 Run 使用稳定 primary key；Run 的 dot owner 有外键；Dot 的复合 `(id, inFlightRunId)` 引用 Run 的 `(dot_id, id)`，使用 deferred foreign key，让原子 pair 能在同一事务内建立与更新。partial unique index 限制同一 Dot 最多一个 pending/running Run。lifecycle/status/revision/time 同时由 SQL constraints 与可信 domain rehydration 校验。

v0/v1/v2 migration 保留既有 conversations、executions、Action Plans/journal、sources、settings、providers 与 encrypted credentials；不从 Conversation 生成 Dot，也不隐式修复旧数据。执行本次 migration 时跳过原构造器的 expired source TTL cleanup，避免迁移顺便删除来源；schema v3 正常重开与既有来源读取仍保持原 TTL 规则。更高版本数据库继续拒绝，不覆盖旧 profile。

既有 live credential selection 显式接受 schema v1/v2/v3，继续拒绝未知版本。它只复制选中的 provider metadata 与 encrypted credential blobs 到 isolated profile，不复制 Dot/Run、Conversation 或 settings；v3 离线回归同时核对源数据库字节未改动和目标 Dot/Run 表为空。这项兼容性验证不调用真实 provider 或搜索服务。

### 原子性、CAS 与可信读取

- repository 写操作使用 `BEGIN IMMEDIATE`，读取 expected revision 后调用 domain command，并执行带 revision 条件的 SQL update。create/start/finish 同时提交 Dot 与 Run；任一写入或 commit 失败均 rollback，不能留下半个 pair。无静默 last-write-wins、自动重试或通用 arbitrary save。
- 读取使用一致的 transaction；先拒绝超过 UTF-8 128 KiB 的 Dot payload 或 4 KiB 的 Run payload，再通过 `rehydrateDot` / `rehydrateDotRun` 验证，检查 SQL column/payload 一致、Run ownership、当前 pointer 与 in-flight uniqueness。字段损坏、extra fields、非法状态/时间/revision、断裂引用均拒绝，不将 corrupt JSON 强转成 domain type。
- 当前 in-flight pair 必须匹配 owner、pointer、dotRevision 与更新时间；所有 Run 的创建/更新时间须落在所属 Dot 的时间范围内，revision 不大于当前 Dot revision。terminal history 不强制与最新 aggregate revision 相等，也不能仍占据当前 pointer。后续 Run 不污染已有 terminal history。
- Repository errors 区分 `not-found / duplicate-id / conflict / invalid-stored-state / storage-failure`；非法 domain 操作继续使用原 `DotError`，不能把领域拒绝、CAS conflict 与 I/O 故障合成一种错误。

### M003 的进程终止边界与 M004 前置条件

独立进程重开后读取相同 Dot identity、goal、lifecycle、revision 与 Run history，证明 **Level 1 — Durable**。事务前后退出验证数据库提交边界，不等于已经实现 crash recovery。已保存的 pending/running Run 与 pointer 原样返回，constructor 与普通 repository read 不标 interrupted、不释放位置、不触发新执行。

M004 Startup Recovery 是独立阶段：需要明确的 exclusive owner 与一致恢复事务，才可结束遗留 in-flight 并更新 Dot/Run pair。未来接入 effects 后，还需保留 uncertain outcome/gate、优先兑现控制意图、禁止重放；恢复策略不能从“当前 lifecycle 仍 active”推导安全 retry。普通仓储不得代替 application 做这项决定。

后续 checkpoint、approval consumption/dispatch 与 wake 分别增加原子提交边界；CAS 冲突不能覆盖新 aggregate，也不能抹掉旧 Run 已发生的实际 receipts。当前 `executions/action_plans/web_sources` 有 conversation 外键，`ResearchPlan` 也绑定 conversation。M009/M010 必须建立明确 Dot owner 接缝，不能把 dotId 冒充 conversationId 或移除现有 FK。

### 内容与权限的恢复边界

完整 history 意味着可检查的 lifecycle、工具决策、effects、来源与结果记录，不意味着永久保存密钥、全部网页正文或 private reasoning。延续当前 Web retention：元数据与正文分开，来源 TTL 仍有效；保存的 URL/hash/title 不证明下一次 run 已读取页面，也不恢复 fetch authority。

Dot checkpoint 最初保存有界事实、notes、工作位置与内部 brief/result。网页正文不全量落盘，长期知识只存必要结构化笔记及来源；全历史不全塞 context。公开 artifact 内容也有容量上限，文件 artifact 必须绑定 authorized scope、hash 与实际成功 receipt；文字里说“已经写文件”不足。

API key 不进入 Dot/DTO/checkpoint；仅保存 provider reference，main 每次按 endpoint-bound credential 与当前 reservation 解密。未授权目录、用户真实 profile 和真实 credential 不用于自动测试。

## 7. Approval、scheduler 与后台宿主

### durable approval 不能用持久 Promise 代替

现在的 `PermissionPort.decide()` 等待 Promise，main 的 pending resolver/grants 在内存；snapshot 保存时主动删除 `pendingPermission`，restart 不恢复批准。`PreparedTool.execute` 是闭包，不能跨进程序列化。把 pending row 存下来、把 timeout 当 sleep 或返回 deny 当 suspension 都不正确。

M008 先补最小、明确、opt-in 的 **runtime suspension/continuation primitive**，仍由 core 拥有执行语义；M009 再接 durable approval 与 exact intent resume。保持现有 Chat 默认等待/超时/配对/cleanup 行为。具体 public contract 应先写 focused ADR，并覆盖所有现有 consumers；不能仅扩大 AgentOutcome union 而漏掉 tool history 和 onSkipped 行为。

待恢复数据是有限、可序列化的 pending intent：call/必要参数、run/goal/policy binding、host-issued immutable preview/digest、scope/file preconditions、expiry 和配对历史。审批请求保存成功后才能设置 approval block、结束本次 invocation 并释放 runtime；不保存执行闭包或活动网络 reservation。

用户 click approve 只原子保存 `pending → approved` 与 resume intent，不提前消费。获得 admission、通过 core/host 重新 prepare/revalidate 后，才原子绑定 approval consumption、本次 resume claim 与 dispatch intent；此后进程崩溃按已消费但效果可能未知处理，不自动重发。审批与 admission 之间重启必须仍能核对 approved pending intent，不能留下没有恢复位置的 consumed 记录。

复验包括 digest、scope/inode、file snapshot、endpoint 与 policy revision。变化、撤销或到期使批准 stale/expired，进入等待并重新展示 preview；不能让模型重新生成另一个工具调用套用旧 approval，也不能重新执行已经完成的历史前缀。拒绝/取消/到期都写独立 event/gate。

现有 research prepare 每次生成新 snapshot ID/time，且 digest 包含 execution binding，直接重新 prepare 会改变 digest。M010 Dot-owned research 必须使用 M009 的 exact intent 原则，定义受验证的、尚未 dispatch 的 research intent rehydration：保持 host-issued logical operation/snapshot identity，将 resume attempt 与批准对象分开绑定；原 expiry、scope、query、预算与已发生 dispatch facts 不得重置。不能恢复旧的已消费 authority/reservation；已 dispatch 或不确定的前缀先核对，不重发。Dot-specific owner/snapshot 采用明确 versioned contract，旧 Conversation ResearchPlan v1 行为不变。此接缝尚不存在，不能声称当前 prepare 已能恢复长期审批。

现有 ResearchAuthorization 仅属于当前 host/run，不能直接跨 wake 或 restart 恢复。M010 只接单次有限研究；M011 独立建立 main-owned bounded repeat-research policy，在明确查询/来源边界、expiry、次数/bytes 与 model/search 累计预算内派生本次执行权限，并支持撤销。scope 外的新查询进入 durable approval。它不续用旧 run grant、不授权 write/shell，也不能由模型扩大范围或重置累计预算。完整 significance/proactive 与动态 integrations 留在 post-MVP。

### one-shot wake intent 与 scheduler

M012 先实现 durable one-shot wake intent、dueAt（UTC ms）、当前 progression/policy binding 与稳定 ID/claim 状态；具体最小字段在该阶段确定。日程文字展示采用用户 timezone；首版输入明确 timestamp，不引入 cron parser。M003 不提前建立这些字段或表。

M014 main scheduler 读取最早 pending dueAt、设置有上限的 timer；timer 触发只发 typed wake event，不直接执行模型。启动、系统恢复与 timer 到期时重查 DB 和当前 wall clock，长时间等待分段重新检查。driver 可替换，核心不调用 `setInterval`。M013 正常 UI 在真正自动 dispatch 前完成观察与控制。

同一 one-shot wake 最多成功 claim 一次；due-check 可以重复，无法承诺所有外部效果 exactly-once。执行 slot 忙时持久保留 pending，释放后 drain；多个 missed recurrence 尚不实现，one-shot overdue 只 catch up 一次。Pause/archive/cancel 取消或隔离 wake，旧 timer 即使到达也不能启动。

scheduler 有界检查不同于无限 LLM loop。没有 active runtime 的等待/睡眠/审批条件不占执行 slot，不依赖挂着 model connection。重复通知也按 event/approval ID 去重。

### M015 窗口生命周期与 MVP 的时间承诺

| 场景 | MVP 应达到的行为 |
| --- | --- |
| 离开 Chat / 切换 Dots 页面 | Dot identity/run/checkpoint 不变，可继续已允许的有限工作 |
| 关闭 macOS 最后窗口，App 留在 Dock | Dot manager/scheduler 继续；Chat 仍按原行为 stop；无窗口遇到批准则 durable wait |
| Cmd+Q / process exit | 完成取消与 cleanup，保存状态；停止执行和 timers |
| 下一次打开时已过 dueAt | recovery 后 claim 一次 overdue wake，继续已保存 checkpoint；不 replay 不确定效果 |
| 机器睡眠/停机时到期 | 恢复/重启后处理 overdue；不声称睡眠或停机期间运行 |

这完成“持续存在、应用活着时自动 wake、退出后恢复位置”。若产品以后要求 App 退出仍准时执行，需要独立宿主/OS integration 决策及权限，不应在首版偷偷安装 daemon。

## 8. Dots UI 与可观察性

UI 在可测试 runner/approval 之后、定时自主工作之前接入。保留现有 Chat/Tasks 入口，新增 `My Dots` 和 Dot Detail；不要将所有工具历史伪装成 conversation。

- list：name、goal、status、last run、next wake、current activity；Create/Open/Run now/Pause/Resume/Archive。
- detail：goal/revision、当前工作项或等待原因、checkpoint facts、runs/events、artifacts、next wake、permissions 与 pending approval。
- timeline：host-owned event sequence/time；呈现实际调用、已确认结果、失败/拒绝/中断以及 observable reason。`currentActivity` 来自实际 runtime event，不展示 private chain-of-thought。
- 外部条件未满足、审批 pending、凭据不可用、预算耗尽、文件效果待核对都显示具体状态与下一步，不停留在伪造的 WORKING。
- `DesktopBridge`/`DesktopEvent` 增加 focused Dot DTO/channel；main 按现有 sender/frame/参数验证。没有通用 `invoke`、fs/shell RPC、SQL 或 key retrieval。
- renderer 增加独立 DotStore，沿用 `useSyncExternalStore` 的更新模式；创建/暂停/批准必须等 main durable response。UI 不运行 scheduler，不把 localStorage 当 durable store。

## 9. 已批准的 M003–M016 Roadmap

每阶段开始重新检查 branch/HEAD/status、runtime 版本、相关 contracts/tests；每阶段独立 commit，结束 clean。测试全部使用 fake model/Web/native ports 与临时 SQLite/文件，不自动调用真实外部 API。main/preload/host/provider 改动完成后 rebuild 并跑相应 Electron E2E；按 README 执行 quality gates。

| Milestone | 范围与预计 owner | 完成标准 |
| --- | --- | --- |
| **M001 Repository / Architecture Discovery** | 本提案、当前 architecture/roadmap 导航 | 真实源码边界、Tempest 冲突、domain/风险/验收路线明确；只有 docs；完成后停止 |
| **M002 Dot Domain & Lifecycle** | 已实现 `packages/dots`：Dot/Goal/Run、独立 lifecycle/status、纯转换、owner/revision/in-flight guards | creation/全部合法非法转换/stable identity/终态/失败不终止 Dot；无 UI/Node/DB/runtime/ports 依赖 |
| **M003 Durable Dot/Run Repository** | 独立 SQLite v3 仓储、public rehydration、CAS、原子 Dot/Run pair 与历史查询 | v0/v1/v2 保留数据；跨进程 roundtrip；duplicate/conflict/corruption/rollback 拒绝；pending/running 原样重读；只有 Level 1 Durable |
| **M004 Startup Recovery** | 明确 exclusive owner 后恢复遗留 in-flight；与普通 repository read 分离 | 原子 interrupted/pointer/revision 一致；不会中断别的活跃 owner；重复 recovery 不重复处理；不启动模型或 replay effects |
| **M005 Shared Execution Admission** | main-owned Chat/Dot 单执行入口；不提前建复杂 scheduler/queue | 初始化前占位；竞争请求不能双 dispatch；Stop/late initialization/credential reservation/cleanup 后正确释放；Chat regression |
| **M006 Minimal Durable Progression** | 有界 checkpoint、已完成/待做事实、当前工作位置与必要 notes/result refs | 跨进程保留前缀与待做项；版本与来源 run 绑定；不依赖全 history；不增加复杂 planner、vector DB 或 autonomous loop |
| **M007 Bounded Dot Runner** | 正式 application/service 接口复用 core、M005 admission 与 M006 progression；有限读取/内部结果 | 垂直切片运行一次有限 DotRun，并证明后续 Run 消费 checkpoint、不从 goal 重做；失败不终止 Dot；pause/cleanup/CAS/提交失败安全停止 |
| **M008 Opt-in Runtime Suspension** | core 最小挂起原语与 focused ADR；保持 Chat 默认行为 | suspension 不伪装 deny/cancel；history 配对、skip/cleanup 与有限预算明确；不在本阶段实现全部持久审批 |
| **M009 Durable Approval & Exact Intent Resume** | pending intent、decision、reprepare/revalidation、consume/dispatch 与 unknown gate | pending 和 approved-before-resume 跨 restart；digest/preconditions/expiry 不变；uncertain effect 不重发；拒绝不靠新 Run 绕过 |
| **M010 Dot-owned Bounded Research** | 正常 runtime/安全 Web 接线、独立 Dot owner 的 journal/source 与 bounded research intent | source 来自实际成功搜索/读取；单次 query/count/bytes/expiry 有界；metadata 不冒充正文；不沿用 Conversation owner 或旧 grant |
| **M011 Bounded Repeat-research Policy** | 明确、可撤销的 main-owned 长期研究 policy；跨 Run 累计预算 | scope 内可继续受控研究；越界新 query 转 durable approval；expiry/revoke/budget 后零 dispatch；不授权 write/shell，不重置额度 |
| **M012 Durable One-shot Wake Intent** | 持久 UTC dueAt、稳定 wake ID 与 claim/取消语义；尚无自动 timer | 重复请求/claim 去重；busy 保留 pending；绑定当前 progression/policy；Pause/archive/旧 intent 不启动新 Run |
| **M013 Observable Dots UI & Controls** | 正常 typed IPC/preload、list/detail/Run now/Pause/Resume/Archive、审批与结果 | 垂直切片从正常 UI 创建和管理 Dot；restart 后状态/历史可查；renderer 无权限扩张；真正自动工作前已有用户控制 |
| **M014 Restart-aware Scheduler** | 可替换 Clock/driver；读取 durable wake；due scan 与 overdue catch-up | fake clock、time jump、busy、重复 timer/restart；恢复先于 dispatch；one-shot overdue 只 claim 一次；不假装外部 effect exactly-once |
| **M015 Window-independent Dot Lifetime** | 分离 Chat/window 与 Dot/app lifetime；明确 Quit/cleanup | macOS 关窗口可继续已允许工作；无窗口遇到审批则 durable wait；Quit 真停止，重开只按恢复/唤醒规则继续；无 daemon |
| **M016 Research MVP Validation** | 正常 Prospero UI/service 路径的完整受控 Research Dot | 离线闭环后获明确数据/凭据/预算授权验证实际研究、来源、brief、checkpoint、wake 与控制；不能用 fake 或绕开产品入口计真实完成 |

### 相对原建议的调整理由

1. M002 已将长期 lifecycle 与 Run status 分离。M003 只建立可信仓储；M004 独立恢复，防止普通 read 偷偷改运行状态。
2. 原 runner 大阶段拆成 M005 admission、M006 progression、M007 runner。持久工作位置先于执行接线，M007 必须交付正式 service 垂直切片。
3. 原 approval 大阶段拆成 M008 suspension、M009 exact intent、M010 Dot-owned research；不能靠一条 pending row 宣称长期审批或真实研究成立。
4. M011 repeat policy 先于自动 wake，以实现用户不必每日重新 prompt 的受控 Research MVP；它与单次研究授权、通知 significance 是不同能力。
5. M012 先存 wake intent，M013 接正常 UI，再做 M014 scheduler 与 M015 窗口 lifetime。M016 以正常产品路径验证完整目标。
6. 不创建 Tempest、完整 workflow engine 或通用 integration framework。完整 plan/task graph、长期 memory/retrieval、event/recurrence、proactive notification、多场景 showcases 与 always-on 宿主属于 post-MVP，按真实需求另行拆分。

Roadmap 是当前获批工程假设；每次只实施一个 milestone，重大调整说明原因并更新文档。本轮只实施 M003。

## 10. 第一个 MVP 的端到端验收

M016 是第一个完整 **Research MVP** 门槛。M007 的有限 service Run 与 M013 的正常 UI 是中途可运行垂直切片，不能替代最终研究验收。M003 只达到 Durable，不提前宣称 Recoverable、Resumable、Schedulable 或 Always-on。

1. 在隔离 profile 的正常 Prospero UI 创建 `Researcher`，goal 为研究 self-evolving agents 并维护 evolving brief。离线先使用明确 fake model/资料；用户配置有界可撤销的 repeat-research policy，禁止它扩大为 write/shell 授权。
2. run 1 形成可检查的 brief artifact、来源 metadata、checkpoint，决定下一 UTC wake；Dot 显示 SLEEPING、last run、next wake 和已完成事实。
3. 离开 Chat 与关闭 macOS 窗口，验证 manager 的独立 lifetime；关闭 App 再打开，验证同一 Dot ID/goal/checkpoint/artifact/run/event 仍在。
4. fake clock 驱动 future wake；另一个场景在进程停机期间跨过 dueAt，下次启动只 catch up 一次。run 2 输入必须包含 run 1 的已保存 checkpoint，并延续待完成任务，不能重做已完成前缀。
5. policy scope 内的 run 2 派生本次有限研究权限，仍重新校验当前 policy/预算/来源；scope 外的新查询进入 NEEDS_APPROVAL 并可跨重启恢复。另测批准后、resume admission 前退出，以及 consume/dispatch 后未确认 receipt 的崩溃。wake 不续签旧 run grant；拒绝、撤销、到期或预算耗尽后不再次派发相同被阻断效果。
6. 独立测试 Pause/Stop/Archive 与触发同时发生、Chat 占执行 slot、重复 timer、过时完成 callback、DB 写失败、初始化取消和 tool cleanup；只有实际 receipts 支持完成结果。
7. UI list/detail/timeline 全部由 durable 状态恢复。执行预算耗尽或来源不足明确展示 incomplete，不能为了 demo 强行标 COMPLETE。

离线 demo 只证明 orchestration/persistence/lifecycle/IPC。M016 还须在明确授权下通过正常 UI/service 获取真实 model/search/page-source/artifact 证据，证明研究结论受来源支持、第二轮延续前次进展。M001–M003 不调用真实模型/搜索/API、不读取用户数据库，也不执行 Dots 工作；存储与 domain tests 不替代后续 runner/scheduler/真实研究验证。

## 11. 关键风险与验收门槛

| 风险 | 具体冲突 | 关闭方式 |
| --- | --- | --- |
| runtime 身份误判 | 当前没有 Tempest，Tasks 是 conversation UI | 保留 core runtime；独立 aggregate；M002/M007 |
| 存储被误称恢复 | 持久 running 不证明已经 reconcile | M003 read 无恢复；M004 exclusive owner 后单独处理 |
| 崩溃窗口 | claim、效果、checkpoint 分开保存会重复或丢进度 | CAS/原子 pair：M003；恢复：M004；progression/intent/unknown：M006/M009 |
| approval 恢复是假实现 | Promise/PreparedTool 不可持久，当前 pending 被删除 | suspension：M008；exact intent：M009；research binding：M010 |
| observer 写失败被忽略 | core onEvent 吞 observer errors | authoritative persistence barrier 与故障注入；M007/M009 |
| scheduler 绕过拒绝/预算 | invocation-local limits 新 run 会重置 | durable gates 与累计 policy budget；M009/M011/M014 |
| Chat/Dot/配置互相竞争 | 单执行与 credentials/provider/Web reservation | shared admission 与 late-result guard；M005/M007 |
| 退出与后台承诺冲突 | 当前关窗口 abort，完全退出无进程 | overdue：M014；窗口 lifetime：M015；Always-on post-MVP |
| checkpoint 等于全文或权限 | 摘要暂存、来源 TTL、research authority run-bound | 有界 progression：M006；来源与新权限：M010/M011 |
| goal/研究完成被模型伪造 | Run succeeded 不证明真实目标 | 正式 service/UI 垂直切片与独立来源/结果验收；M007/M013/M016 |

本阶段不涉及 distributed/multi-node/cloud、swarm、marketplace、billing、enterprise RBAC、复杂 vector DB、mobile push、任意 connectors 或自动安装后台服务。

## 12. 源码索引与验证边界

下表既有代码行号保留 M001 开始 HEAD 的历史证据，不作为 M003 修改后的当前行号。M002 仅新增 `packages/dots` 及 workspace lock 注册；M003 扩展纯 rehydration 与 persistence，没有接入 core/main/host/UI 的 Dot 执行能力。

| 证据 | 位置 |
| --- | --- |
| 工程 ownership / 不创建 Tempest / tests policy | `AGENTS.md:3-13` |
| workspace/scripts/runtime pin | `package.json:13-35`；`docs/DEVELOPMENT.md:3` |
| 实际 runtime options/outcome/ports | `packages/core/src/types.ts:47-136` |
| bounded loop / deny ledger / observer | `packages/core/src/index.ts:143-183` |
| completed 条件与 permission wait/cleanup | `packages/core/src/index.ts:337-339, 426-465, 498-515` |
| effect/scope/journal 与 conversation-bound ResearchPlan | `packages/core/src/actions.ts:1-17, 85-91, 108-121` |
| execution-only summary | `packages/core/src/context.ts:11-14` |
| DB version / tables / FK / journal trigger | `packages/persistence/src/index.ts:32-106` |
| journal authoritative transaction | `packages/persistence/src/action-journal.ts:55-65, 171-195` |
| conversation-bound executions / restart interruption | `packages/persistence/src/index.ts:272-306` |
| main ownership / restart handling | `apps/desktop/src/main/service.ts:113-189` |
| window suspension / durable snapshot stripping / batching | `apps/desktop/src/main/service.ts:217-223, 483-521, 536-549` |
| sendTask admission 与 composition | `apps/desktop/src/main/service.ts:916-933, 992-1100` |
| pending approval / grants / shutdown | `apps/desktop/src/main/service.ts:1245-1335` |
| research snapshot identity / digest | `apps/desktop/src/main/research-authorization.ts:223-238`；`apps/desktop/src/main/web-tools.ts:143-153` |
| renderer crash / close / app quit | `apps/desktop/src/main/index.ts:126-156, 321-341` |
| public Conversation / Settings Memory / bridge | `apps/desktop/src/bridge.ts:35-44, 73-105, 143-189` |
| preload allowlist / validated IPC | `apps/desktop/src/preload.ts:4-39`；`apps/desktop/src/main/ipc-boundary.ts:28` |
| renderer list/store | `apps/desktop/src/renderer/App.tsx:407-467, 574-648`；`apps/desktop/src/renderer/conversation-store.ts:3-56` |
| 当前验证事实及限制 | `README.md:104, 118-150`；`docs/V1-VALIDATION.md`；`docs/V1-REAL-VALIDATION.md` |

已静态检查上述 contracts、composition、storage、UI、重要 ADR/README/architecture/roadmap，以及已有 unit/acceptance/Electron E2E 的组织方式。M001 的 quality gate 实际命令/结果在当次 Milestone Result 中报告；不把文档提案当运行验证，不新增镜像实现的测试。

M002 domain tests 与完整 regression 的实际命令/结果见当次 Milestone Result。M003 当前入口为 `packages/dots/src/index.ts` 的 rehydration exports、`packages/dots/src/rehydration.ts`，以及 `packages/persistence/src/index.ts` 的 schema migration / `ProsperoStore.dots()`；独立仓储、schema 与 typed errors 分别位于 `dot-repository.ts`、`dot-schema.ts` 与 `dot-errors.ts`。对应新增 tests 验证临时数据库、独立进程、CAS/rollback/损坏读取与旧数据保留，credential selection 回归验证 v3 密文选择范围。M003 已通过离线验证；精确命令、测试数及 quality gate 结果在 M003 Milestone Result 中报告，真实任务仍为 `0/30`。

M003 完成后只建议 **M004 Startup Recovery**；须先定义 exclusive owner 与恢复事务，不自动开始实现。跨进程重新读取保存状态不能作为 recovery、autonomous execution 或 Research MVP 的验收证据。
