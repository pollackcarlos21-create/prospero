# Dots 架构与 Domain — M001 / M002

M001 日期：2026-10-06（Asia/Shanghai）。M002 更新：2026-10-07。状态：**M002 纯 domain/lifecycle 已实现；persistence、runner、scheduler、approvals 和 UI 尚未实现**。

M001 完成 Repository / Architecture Discovery，并停止于 commit `62d1f9c`。用户随后明确授权 M002 Dot Domain & Lifecycle。以下长期 persistence/runtime/UI 设计仍为提案；M002 只实现独立的纯 domain，不自动进入 M003。

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

历史笔记用于定位代码，所有当前结论重新检查了上述 HEAD。旧文档中的“未 commit/push”或早期 schema 描述不能代替当前 Git 与源码事实。`docs/V1-VALIDATION.md` 是既有验证记录，不能算作 M001 重新执行的测试；它仍明确固定真实任务为 `0/30, pending`。

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
| `packages/dots` | M002 纯 identity/goal、Dot/Run lifecycle、in-flight/reference/revision guards | 零依赖；尚未接入任何产品 execution 或 storage |
| `packages/providers` | OpenAI-compatible model adapter、bounded stream、连接测试、endpoint policy | 复用 `ModelPort`；不让 provider 管理 wake 或 Dot status |
| `packages/tools` | host-neutral metadata、参数校验、资源上限 | 复用工具定义与解析；不能让模型提交任意宿主能力 |
| `packages/local-host` | multi-root scopes、文件 discovery/read、结构化 Action Plan、stale 检查、shell cleanup | 复用 prepare/execute 和 journal；shell cwd 仍不是 OS sandbox |
| `packages/web` | Brave/Tavily search、安全 public HTTPS fetch、地址校验、正文提取、source receipts | 复用 transport；研究授权目前在 main 且绑定 conversation/run |
| `packages/persistence` | schema v2、SQLite WAL、conversations、executions、immutable action plans、append-only action journal、来源 metadata、密文凭据 | 复用数据库与事务模式；需要独立 Dot persistence adapter |
| `apps/desktop/src/main` | composition、凭据 reservation、审批、恢复报告、native adapters、窗口/退出生命周期 | Dots runner、scheduler adapter 与全局执行 admission 的落点 |
| renderer | task/conversation sidebar、timeline、approval previews、Sources、Settings、显式 Memory | 增加独立 Dots views/store；保持现有 conversation flow |

### Chat、Tasks、Memory、Computer 的真实含义

- 当前 `New task` 创建的是 `Conversation`；`sendTask(conversationId, text)` 启动一次 execution。没有独立的 persistent Goal/Task workflow aggregate。DotTask 应表示 Dot 内计划工作项，不能复用 UI task 名称推断已有实体。
- `Conversation` 是交互和展示记录，`ExecutionRecord` 是一次 conversation-bound 执行摘要。二者都不承担长期 agent identity。
- 显式 Memory 是 `Settings.memory: MemoryEntry[]`；`ContextWindow` 的滚动摘要仅在本次 execution 内存在。它们均不是 Dot 的长期 checkpoint。
- Computer 当前包括受 scope 约束的文件操作、逐命令批准且具有完整 OS 用户权限的 shell、Finder/clipboard/Trash 等 native adapters；没有通用浏览器 click/type 或 computer-use runtime。
- M002 已有独立 Dot/Run domain，但当前产品路径仍未接入 Dot runner/store/UI；没有 scheduler、持久 wakeup、事件 trigger 或独立后台 worker。`DesktopService.timers` 是 32 ms UI stream batching。

### 当前执行与恢复约束

`runAgent()` 已经有有限 loop：默认 12 model turns、32 tool calls、180 s active、300 s 单次审批、900 s wall clock。Desktop 显式配置 24/64、600/300/1800 s，并把 credential/scope 初始化时间计入总 wall clock。不要为 Dots 另写一个无限 LLM loop。

`AgentOutcome` 只有 `completed | failed | cancelled`。其中 `completed` 表示本次模型回复没有继续请求工具，**不证明长期 goal 已达成**。目前没有 sleep/continue/checkpoint/suspended outcome，也没有可序列化的 pending execution。

当前同时只允许一个 active task，初始化前已预留 execution；provider/Web 配置与 native credential 操作另有 reservation。Dots 接入必须延续这些排他语义。

重启时 `interruptExecutions()`、`recoverActionPlans()` 和 main recovery 会标记 interrupted、补齐 tool history、生成事实报告；不重放工具、不恢复 grants。已完成效果、未执行效果和需检查效果必须继续区分。

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

Chat 与 Dot 共用 main-owned execution admission。不要为 Dot 新开一份互不知情的 active map。先实现一个有界队列：前台用户请求优先，Dot 按 due time 和稳定 ID 排序；已运行工作不被无提示抢占。重复 wake 合并到稳定 wake ID，队列大小有限，拥塞状态可查看。

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
| `DotTask` | Dot plan 中可交付工作项，status/dependencies/current task/result refs；不等于 conversation 或 run | M008 |
| `DotRun` | M002 已实现：`id/dotId/dotRevision/status`、createdAt/updatedAt、状态对应的 startedAt/finishedAt；没有 runtime、wake 或 artifact payload | M002 |
| `DotEvent` | host-issued id、dotId/runId、递增 sequence、time、typed kind、observable payload；append-only | M003 |
| `DotCheckpoint` | immutable version、目标绑定、已完成/待做事实、notes、当前工作项、artifact/source refs、continuation reason；不是进程快照 | M004 |
| `DotTrigger` | 拟议 typed wake cause：manual/time，之后 event/dependency/user-message；携带幂等 ID | M007，M009 扩展 |
| `DotSchedule` | MVP 为一次绝对 UTC wake；未来 recurrence 独立扩展；展示使用用户 timezone | M007 |
| `DotApproval` | request/snapshot/digest、dot/run/goal/policy revision、effect/resource、pending/approved/denied/expired/consumed、expiry、用户决策 event | M005 |
| `DotPermission` | 拟议 main-owned scope references、allowed capability 与明确授权边界、policy revision、denial gates；不保存 API key，也不把 plan 等同 capability | M005 |
| `DotMemory / DotContext` | 带来源的 structured notes/facts/task summaries；从有限 checkpoint 起步，不保存全部网页或自动 global Memory | M004 最小 checkpoint；M010 完整管理 |
| `DotArtifact` | result kind/title、run/task refs、host-verified content/hash 或 authorized file ref、createdAt、验证状态 | M004 最小内部结果；M008 扩展 |

`lastRunAt`、`nextWakeAt`、`currentActivity` 可以是查询投影，但其原始事实来自已提交 run/wake/events；缓存必须和 aggregate revision 对齐。所有 public DTO 都是最小可观察数据，不含 credential、PreparedTool 或私有推理。

### 最小 application API

M002 public commands：`createDot/pauseDot/resumeDot/completeDot/cancelDot/archiveDot`，以及 `createDotRun/startDotRun/finishDotRun`。只导出必要的 entity/ID/status/change types、status constants 和 `DotError`；validation/snapshot helpers 不在 public entry 导出。

`getDot/listDots` 与 store-based update 留给 M003 以后的 application；M002 不提供 repository、goal 编辑、run history list 或 hard-delete。未来宿主创建 ID/time 并在持久化成功后返回 DTO，新增 consumer 在自己的 package.json 声明 `@prospero/dots: workspace:*`，不为未接线能力增加 desktop dependency。

M002 `pauseDot` 只接受无 in-flight 的 active Dot。它不 abort、不停止 OS 进程；future application stop/pause 必须先阻止 admission、等待实际 cleanup、结束 Run，再调用该纯转换。`finishDotRun(..., 'cancelled', ...)` 仅取消本次 Run，`cancelDot` 才取消长期目标。archive 保留 domain identity，future store 保留 history。

### 后续 ports 与最小存储语义（M002 不实现）

| Port | 必需语义 |
| --- | --- |
| `DotStorePort` | create/read/list；revision-checked aggregate update；atomic claim/start/finish/checkpoint+wake；append event；recover interrupted；返回明确 conflict/not-found/storage-failure |
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

future claim 必须满足 lifecycle active、无 in-flight、wake eligible、无控制/recovery 阻断；effect-specific denial 继续限制 host，但允许无被拒效果的安全重规划。due 只标 eligible，成功 admission 后才原子 claim/create/start；WAIT/睡眠/审批挂起结束本次 invocation，释放 slot，并保存独立条件。具体 Run suspension primitive 及必要类型扩展留在 M005，不能用 cancelled/denied 假装 suspended。

崩溃恢复记录原 Run interrupted，并优先兑现停止/取消/归档意图；未知效果保留 recovery block，不能因 Dot 仍 active 就自动重放。预算/无进展失败也需要 application gate；domain 允许新的显式 Run，不自动执行 retry。

### 一次有限 run 的事务顺序

1. 验证 Dot/goal/policy revision、scope identity、provider availability、denial/recovery gates，获得共享 admission。
2. 原子 claim wake，创建/启动 DotRun 并保存对应 Dot pointer/revision、run-start event；Dot lifecycle 仍 active，提交失败时不读取凭据、不请求模型。
3. main 在既有 credential reservation 中初始化 adapters；context 来自有限 checkpoint、明确 goal、task/notes 和必要来源 metadata。
4. 调用当前 core runtime；继续用同一预算、AbortSignal、host prepare/execute、permission 与 effect journal。
5. runtime 结束后，由 main 校验 `DotStepProposal`：`CONTINUE / WAIT / SLEEP / REQUEST_APPROVAL / REQUEST_USER_INPUT / COMPLETE / FAIL`。模型只能提出下一步，不能更改授权、直接设置状态或发 timers。
6. 原子写 run outcome、checkpoint、artifact refs、events、Dot status 和 wake；提交成功才发布 UI 并安排下一次 timer。
7. 释放 admission；CONTINUE 通过新 wake/queue 且受连续次数、累计预算与最小间隔限制。停止、无进展或预算耗尽进入可观察等待，不反复“新 run 重置额度”。

M004 推荐通过 adapter 注册一个严格校验的 application control tool `checkpoint_dot`，记录有限 continuation proposal；它不调用 DB/timer/外部能力。第一次合法 proposal 之后阻止后续 effect tools，待 core 正常结束再提交。重复/缺失/非法 proposal、目标绑定不匹配或 invocation failed 时不标 goal 完成，记录 Run outcome 与独立失败/等待条件；不要用关键词匹配 assistant prose。schema、终止门控和预算须通过 fake model 验证，不依赖 provider structured-output 新协议。

M004 首先只开放无外部效果的内部结果和明确 scope 的读取能力；联网、write/shell 与跨重启 approval continuation 在 M005 的 owner/授权接线完成后才开放。Researcher 的 fake 研究材料仅证明 context continuation，不冒充真实联网研究。

## 6. Persistence 与恢复

M003 在现有 `ProsperoStore` 数据库增加一个明确的 Dot adapter。计划使用 schema v3；实施时重新核对当前 `user_version`，不能假定版本一直为 2。保持 conversation/history/settings/providers/credentials 的旧查询行为，迁移不从 Conversation 自动生成 Dot。

M003 先保存已实现 Dot（含单个 DotGoal）与 DotRun 快照及原子双实体转换；不机械建立独立 goal/checkpoint/wakeup 表。events/recovery 按实际原子审计需要确定；M004/M007 再增加 checkpoint/wake，M005 增加 approval/gate 与 Dot-owned effect journal/source 存储。不能提前建立完整 tasks/vector/integration schema。

- Dot 有独立 primary key、revision 与 lifecycle；pending/running Run 都占位，Run ID 唯一与快照 CAS 在 store enforce；未来 wake 用稳定 ID 去重。
- checkpoint immutable 且有 schema version、goal revision、来源 run；event sequence 唯一并 append-only。最小查询投影可随 migration 版本演进。
- 所有 transition 用事务/CAS guards；不能用 SQLite 最后写入覆盖方式吞掉 pause 与 finish race。
- 应用崩溃在 claim 后：该 run interrupted，已提交的 pause/cancel/archive intent 优先兑现；在效果 intent 后、receipt 前：标 outcome unknown/needs inspection；在最终 checkpoint 提交后：checkpoint 与 wake 一起可见，不再次交付同一内部 artifact。
- 旧 finish 的 CAS 冲突不能覆盖更新后的 Dot，但该 Run 的实际 partial/cleanup receipts 与 terminal audit 仍须按原 run identity 保存；恢复和 UI 不能因为 aggregate 冲突而丢失已发生事实。
- 未来重启处理 overdue wake 前完成 recovery scan。pending/running Run 或未确认效果不直接 replay；已干净结束的 Run/checkpoint 可在唤醒条件满足后开始一个新 Run。
- DB commit 失败、磁盘满或非法 schema 时停止 admission，保留可核对证据；恢复数据库后先 reconcile，不自动重发效果。

当前 `executions/action_plans/web_sources` 有 `conversation_id` 外键，`ResearchPlan` 也显式有 `conversationId`。M005 采用独立 Dot-owned 存储 adapter，并在实际 host/research 接缝引入 typed `ExecutionOwner = ConversationOwner | DotOwner`；旧 conversation owner 保持兼容。可复用 journal 验证逻辑，但不能把 dotId 写到 conversationId 字段或移除现有 FK 强行通过。

### 内容与权限的恢复边界

完整 history 意味着可检查的 lifecycle、工具决策、effects、来源与结果记录，不意味着永久保存密钥、全部网页正文或 private reasoning。延续当前 Web retention：元数据与正文分开，来源 TTL 仍有效；保存的 URL/hash/title 不证明下一次 run 已读取页面，也不恢复 fetch authority。

Dot checkpoint 最初保存有界事实、notes、工作位置与内部 brief/result。网页正文不全量落盘，长期知识只存必要结构化笔记及来源；全历史不全塞 context。公开 artifact 内容也有容量上限，文件 artifact 必须绑定 authorized scope、hash 与实际成功 receipt；文字里说“已经写文件”不足。

API key 不进入 Dot/DTO/checkpoint；仅保存 provider reference，main 每次按 endpoint-bound credential 与当前 reservation 解密。未授权目录、用户真实 profile 和真实 credential 不用于自动测试。

## 7. Approval、scheduler 与后台宿主

### durable approval 不能用持久 Promise 代替

现在的 `PermissionPort.decide()` 等待 Promise，main 的 pending resolver/grants 在内存；snapshot 保存时主动删除 `pendingPermission`，restart 不恢复批准。`PreparedTool.execute` 是闭包，不能跨进程序列化。把 pending row 存下来、把 timeout 当 sleep 或返回 deny 当 suspension 都不正确。

M005 需要先补最小、明确、opt-in 的 **runtime suspension/continuation primitive**，仍由 core 拥有执行语义，Dots 拥有 durable approval/lifecycle。保持现有 Chat 默认等待/超时/配对/cleanup 行为。具体 public contract 应先写 focused ADR，并覆盖所有现有 consumers；不能仅扩大 AgentOutcome union 而漏掉 tool history 和 onSkipped 行为。

待恢复数据是有限、可序列化的 pending intent：call/必要参数、run/goal/policy binding、host-issued immutable preview/digest、scope/file preconditions、expiry 和配对历史。审批请求保存成功后才能设置 approval block、结束本次 invocation 并释放 runtime；不保存执行闭包或活动网络 reservation。

用户 click approve 只原子保存 `pending → approved` 与 resume intent，不提前消费。获得 admission、通过 core/host 重新 prepare/revalidate 后，才原子绑定 approval consumption、本次 resume claim 与 dispatch intent；此后进程崩溃按已消费但效果可能未知处理，不自动重发。审批与 admission 之间重启必须仍能核对 approved pending intent，不能留下没有恢复位置的 consumed 记录。

复验包括 digest、scope/inode、file snapshot、endpoint 与 policy revision。变化、撤销或到期使批准 stale/expired，进入等待并重新展示 preview；不能让模型重新生成另一个工具调用套用旧 approval，也不能重新执行已经完成的历史前缀。拒绝/取消/到期都写独立 event/gate。

现有 research prepare 每次生成新 snapshot ID/time，且 digest 包含 execution binding，直接重新 prepare 会改变 digest。因此 M005 的 focused ADR 还必须定义受验证的、尚未 dispatch 的 pending research intent rehydration：保持 host-issued logical operation/snapshot identity，将 resume attempt 与批准对象分开绑定；原 expiry、scope、query、预算与已发生 dispatch facts 不得重置。新的用户决策仅支持该 pending operation，不能恢复旧的已消费 research authority/reservation；已 dispatch 或不确定的前缀先核对，不重发。Dot-specific owner/snapshot 采用显式 versioned contract，旧 Conversation ResearchPlan v1 行为不变。此接缝尚不存在，不能声称当前 prepare 已能恢复长期审批。

现有 ResearchAuthorization 仅属于当前 host/run，不能直接跨 wake 或 restart 恢复。首版新的研究轮需要新的有限授权；未来常驻研究 policy 是单独 milestone，必须限制 query/source/count/bytes/time/expense 并支持撤销。需求示例中的 `search web AUTO` 不作为现有默认权限，否则会破坏当前合理安全边界。

### one-shot scheduler

DotWakeup 最小字段：stable id、dotId、dueAt（UTC ms）、cause、checkpoint/goal/policy revision、pending/claimed/consumed/cancelled。日程文字展示采用用户 timezone；首版输入明确 timestamp，不引入复杂 cron parser。

main scheduler 读取最早 pending dueAt、设置有上限的 timer；timer 触发只发 typed wake event，不直接执行模型。启动、系统恢复与 timer 到期时重查 DB 和当前 wall clock，长时间等待分段重新检查。driver 可替换，核心不调用 `setInterval`。

同一 one-shot wake 最多成功 claim 一次；due-check 可以重复，无法承诺所有外部效果 exactly-once。执行 slot 忙时持久保留 pending，释放后 drain；多个 missed recurrence 尚不实现，one-shot overdue 只 catch up 一次。Pause/archive/cancel 取消或隔离 wake，旧 timer 即使到达也不能启动。

scheduler 有界检查不同于无限 LLM loop。没有 active runtime 的等待/睡眠/审批条件不占执行 slot，不依赖挂着 model connection。重复通知也按 event/approval ID 去重。

### MVP 的时间与后台承诺

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

## 9. 基于当前代码的 milestone plan

每阶段开始重新检查 branch/HEAD/status、runtime 版本、相关 contracts/tests；每阶段独立 commit，结束 clean。测试全部使用 fake model/Web/native ports 与临时 SQLite/文件，不自动调用真实外部 API。main/preload/host/provider 改动完成后 rebuild 并跑相应 Electron E2E；按 README 执行 quality gates。

| Milestone | 范围与预计 owner | 完成标准 |
| --- | --- | --- |
| **M001 Repository / Architecture Discovery** | 本提案、当前 architecture/roadmap 导航 | 真实源码边界、Tempest 冲突、domain/风险/验收路线明确；只有 docs；完成后停止 |
| **M002 Dot Domain & Lifecycle** | 已实现 `packages/dots`：Dot/Goal/Run、独立 lifecycle/status、纯转换、owner/revision/in-flight guards | creation/全部合法非法转换/stable identity/终态/失败不终止 Dot；无 UI/Node/DB/runtime/ports 依赖 |
| **M003 Dot Persistence & Recovery** | `packages/persistence` Dot adapter、迁移与最小独立记录；get/list/application API | 新进程保存同一身份/goal/Run/归档状态；双快照原子保存、CAS 与 Run ID unique；旧 profile 兼容；migration/failure/crash tests；不接真实 runtime |
| **M004 Bounded Dot Runner** | main DotManager/当前 core adapter、共享 admission、有限 checkpoint/result、pause/stop/recovery gates；不提前开启 network/write/shell | fake model 两次 invocation 明确读取上次 checkpoint；每次有限，completed 不误判 goal complete；pause/Stop 后无后续效果；Chat/Dot 不并发；checkpoint failure 阻止继续；前缀不 replay |
| **M005 Durable Approval & Effect Ownership** | core opt-in suspension primitive + focused ADR；main/host 的 Dot owner、审批/gates、stable pending intent rehydration；persistence Dot journal/source；沿用现有安全 Web/Action Plan | 批准等待与 approve 后未 resume 均可跨 restart；重建必须同 intent/digest/preconditions；resume claim/consume/dispatch 原子；stale/deny/expiry 无效果；跨 run deny 不绕过；default Chat 全部 regression；没有窗口也能安全等待 |
| **M006 My Dots & Detail** | typed IPC/preload + renderer list/detail/control/timeline/approval；最小内部 artifact 展示 | 用户可创建、运行、停止/暂停、恢复、归档；restart 身份/历史/审批仍可检查；无 renderer privilege；对应 Electron E2E |
| **M007 One-shot Wake & Window-independent Lifecycle** | main timer/clock adapter、DB wake claim/overdue catch-up、Chat/window 与 Dot/app 生命周期拆分 | 完成下述端到端 MVP；关窗口可继续已允许工作；Quit 真停止；恢复 overdue 只一次；pause/archive/late callback/busy queue/clock-change tests |
| **M008 Persistent Plan / Tasks / Results** | 简单 DotTask plan、current task、完成事实与 artifact receipt；不给复杂 planner | 两次 wake 接着 current task 工作；结果能核验；只输入有界 checkpoint，任务变更增加 revision |
| **M009 Event Triggers** | 将现有 manual/time wake 接入统一 envelope，再增 user message/dependency/application event | 不同原因同样去重、guard、admission、checkpoint；仅实现实际需要的 event；webhook/connectors 延期 |
| **M010 Dot Memory** | structured notes/facts/summaries + provenance/retention 与有限 context assembly | 多次 run 后不用塞全历史；旧 facts 与新来源分开；memory 不授予权限；内容/schema/size bounds 和删除更新可测 |
| **M011 Proactive Policy & Notifications** | 用户明确可撤销的有限研究 policy、跨 wake 预算、变化判定、通知去重 | 无重要变化静默 sleep；必要变化/失败/用户动作才通知；不由模型扩授权；持续监测不重置总预算 |
| **M012 Real-world Showcases** | Research Dot → Project Watcher Dot → 有适配器后再 Job Scout Dot | 公共/临时素材的离线端到端先通过，再在明确凭据/数据/预算授权下实测；缺 connector 不用 shell 绕过；至少三个示例分别证明真实目标 |

### 相对原建议的调整理由

1. 将 M005 state machine 提前 M002，防止 CRUD/store/runner 先建立不可控状态。
2. 将 durable approval 从高级阶段提前自动 wake 之前，因为当前 runtime 没有跨进程等待语义；有副作用/联网的持续工作不能绕过此缺口。
3. 将 UI 放在 runner/approval 后、scheduler 前，让第一个自动执行版本已经有完整控制与状态观察。
4. 不单独新建 Tempest；当前 `core.runAgent` 已拥有执行 loop/取消/预算，缺失 suspension 作为最小 runtime primitive 扩展。
5. 先 one-shot timestamp 与 overdue catch-up，再统一 event/recurrence；长期 plan/memory/showcases 等第一闭环完成后逐步做。

## 10. 第一个 MVP 的端到端验收

M007 是第一个完整 MVP 门槛，M002–M006 只分别交付基础能力，不称 MVP 已完成。

1. 在隔离 profile 的正常 Prospero UI 创建 `Researcher`，goal 为研究 self-evolving agents 并维护 evolving brief。第一次测试用明确 fake 公共资料与 model；用户批准有限研究 scope。
2. run 1 形成可检查的 brief artifact、来源 metadata、checkpoint，决定下一 UTC wake；Dot 显示 SLEEPING、last run、next wake 和已完成事实。
3. 离开 Chat 与关闭 macOS 窗口，验证 manager 的独立 lifetime；关闭 App 再打开，验证同一 Dot ID/goal/checkpoint/artifact/run/event 仍在。
4. fake clock 驱动 future wake；另一个场景在进程停机期间跨过 dueAt，下次启动只 catch up 一次。run 2 输入必须包含 run 1 的已保存 checkpoint，并延续待完成任务，不能重做已完成前缀。
5. run 2 如果需要新的 network/write/shell 授权，进入 NEEDS_APPROVAL 并可跨重启恢复；另测批准后、resume admission 前退出重启，以及 consume/dispatch 后未确认 receipt 的崩溃。新的 wake 本身不续签旧授权，拒绝后下一次 wake 不重复执行同一效果。
6. 独立测试 Pause/Stop/Archive 与触发同时发生、Chat 占执行 slot、重复 timer、过时完成 callback、DB 写失败、初始化取消和 tool cleanup；只有实际 receipts 支持完成结果。
7. UI list/detail/timeline 全部由 durable 状态恢复。执行预算耗尽或来源不足明确展示 incomplete，不能为了 demo 强行标 COMPLETE。

上述未来离线 demo 用于证明 orchestration/persistence/lifecycle/IPC 正常。要声称“第二天真实继续研究”还需正常产品入口的真实 model/search/page-source/artifact 证据；M001/M002 未调用模型/搜索/API、未读取用户数据库、未执行 Dots demo。M002 已有纯 domain tests，但不能替代尚未实现的 Dot persistence/runner/scheduler 集成测试。

## 11. 关键风险与验收门槛

| 风险 | 具体冲突 | 关闭方式 |
| --- | --- | --- |
| runtime 身份误判 | 当前没有 Tempest，Tasks 是 conversation UI | 保留 core runtime；Dot 独立 aggregate 与 owner；M002/M004 |
| 崩溃窗口 | claim、效果、checkpoint 分开保存会重复或丢进度 | 原子 commit、intent/receipt、revision/claim、unknown gate；M003/M004/M005 |
| approval 恢复是假实现 | Promise/PreparedTool 不可持久，当前 pending 被删除 | opt-in suspension 与 exact intent reprepare；M005 |
| observer 写失败被忽略 | core onEvent 吞 observer errors | authoritative persistence barrier + abort + fault injection；M004/M005 |
| scheduler 绕过拒绝/预算 | invocation-local deny/limits 新 run 会重置 | Dot durable gates、跨 run 连续/累计预算；M004/M005/M011 |
| Chat/Dot/配置互相竞争 | 全局一个 active task，credentials/provider/Web 有 reservation | 共享 admission，继续 reservation/late-result guard；M004 |
| 退出与后台承诺冲突 | 当前关窗口 abort，完全退出无进程 | 只拆 window/app lifetime；退出恢复 overdue；M007 |
| checkpoint 等于全文或权限 | 摘要暂存、来源 TTL/正文不落盘、research authority run-bound | 结构化 context + provenance/retention，新授权；M004/M005/M010 |
| goal 完成被模型伪造 | AgentOutcome completed 不是长期验收 | validated control proposal + host artifact/goal verification；M004/M008 |
| 真实能力被离线证据扩大 | 既有 30/30 offline 不等于真实 27/30，也不证明 Dot | fake/real/UI/package/CI 分别记录；M007/M012 |

本阶段不涉及 distributed/multi-node/cloud、swarm、marketplace、billing、enterprise RBAC、复杂 vector DB、mobile push、任意 connectors 或自动安装后台服务。

## 12. 源码索引与验证边界

以下既有代码行号对应 M001 开始 HEAD。M002 仅新增独立 `packages/dots` 及 workspace lock 注册，没有修改现有 core/main/host/UI 或 persistence 实现。

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

M002 domain tests 与完整 regression 的实际命令/结果见当次 Milestone Result；包源码入口为 `packages/dots/src/index.ts`。下一阶段仅建议 M003 Dot Persistence & Recovery；实施前重新核对分支、HEAD 和工作区。本次停止于 M002。
