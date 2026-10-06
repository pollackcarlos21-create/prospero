# Prospero v1.0 真实任务验证规范

日期：2026-10-06。本文补充真实验证的最小执行与验收边界，不修改 [V1-ACCEPTANCE.md](./V1-ACCEPTANCE.md) 的固定 30 个任务或完成标准。

2026-10-06 用户亲自试用后确认产品可以联网，接受本轮目标并授权上传 GitHub。本轮按该人工确认交付当前 0.2.0；固定 30 项正式真实验证保留为后续工作，不把人工联网试用换算成逐项完成成绩。下述 DNS 失败属于此前机器观察，不作为当前上传阻塞。

当前状态：完整的真实 30 项 runner 尚未装配；真实任务为 **0/30，pending**。已离线实现预算 manifest、SQLite dispatch journal、provider/Web transport 计量接缝、精确快照匹配和 `test:live-dry-run` 默认拒绝检查。2026-10-06 human 明确授权真实联网试用，提供 Tavily 和 DeepSeek 凭据，并要求仅一两个小问题、不另设预算讨论；该授权保留。小试用实际发出 **3 次业务 HTTP**（Tavily 两次、DeepSeek 一次，均 HTTP 200），原生默认安全网页读取因本机 DNS 返回 blocked addresses 在 HTTP 前停止。使用公开论文问题及一句模型连接问题，没有用户文件或持久化真实 key；结果不属于正常 DesktopService/UI/工具循环或固定 30 项验收。详情见 [V1-VALIDATION](V1-VALIDATION.md)。首次试用不自动扩展为完整 30 项。实际签名包曾出现 native availability 未 settle，当前包 synthetic 凭据回归通过；跨安装/重签/OS 授权状态的 readiness 仍未证明。

## 1. 验证对象与替身边界

真实任务路径必须经过实际 `DesktopService`、`OpenAICompatibleProvider`、所选 `BraveWebClient` / `TavilyWebClient`、系统 DNS、实际 pinned HTTPS/TLS transport、文件 host、OS-backed credential vault 和 SQLite。模型自行决定工具与结论；不得使用 `Planner`、预先返回工具调用的 fake provider、fake Web corpus、fake DNS、fake vault 或 fake Trash 替代这条路径。

当前 `tests/acceptance/harness.ts` 显式依赖上述替身，`run(task, planner)` 和默认全批审批仅服务离线链路，不能改标签后用于真实计分。冻结合成字段驱动的比较、消歧和分类证明数据链完整，不证明真实模型研究能力。

最小 live runner 可以直接执行源码中的任务层服务，并使用临时 fixture 根目录；它必须记录 source identity，且把此结果与 packaged/UI 证据区分。若以发行包声称就绪，须另记录该包、主进程 bundle、Electron 和签名身份，验证 packaged UI、冷首次保存与重启解密读取，不能由源码任务结果推导。

DesktopService 已增加内部 `providerFetch` 构造参数，默认仍为实际 fetch；连接测试与实际 OpenAICompatibleProvider（含 execution-only 摘要）共用该入口。现有 `webFactory` 可包装 BraveWebClient 的实际 DNS/TLS transport。这些 main-only 接缝用于预算与证据，不改变 agent policy、core public contracts，不向 renderer 提供密钥读取、通用网络或任意执行能力。

`live-transport.ts` 默认 provider fetch 和系统 DNS/pinned HTTPS transport，并逐请求预留、提交 durable dispatch intent、检查 gate 后才进入 transport。测试显式注入离线端口；Web 返回 `production-default` / `offline-injected` 标签，不能把后者计作实际 TLS。服务集成覆盖连接探测、任务、摘要、研究批准后的 search/fetch，且缺授权或越额不调用端口。固定任务目录、独立临时 fixture/file oracle、逐阶段 controller、实际 DesktopService 组合与来源/故障观察已离线接入。完整父 runner、C07 退出/重启协调、真实 native 就绪与 human 审查获取仍须装配与验证。

### 任务层主进程组合与观察

`live-desktop-runtime.ts` 复用实际 DesktopService、SQLite、provider/Web meters 与 file host，不修改产品 public contracts。W10 关闭服务和 SQLite 后重开同一隔离 profile；C09 实际 running INSERT 触发失败，确认无文件效果后解除再重开。C05 在第一项实际成功 journal 后同步 Stop；C04 在实际页面工具结果与独立 SQLite source 都存在后同步 Stop。每阶段保留独立请求/方案，新授权不继承。取消直接传给实际 service；并发 cleanup 共用同一结果。生产模式禁止显式网络替身；离线模式强制完整 fake provider/DNS/transport，防漏传后落入外网。

`live-web-observer.ts` 绑定实际成功搜索 → 当前 pending fetch_source ID → 抓取回执与来源；缺失或歧义使验收 unknown/pending。W06/W07/C08 仅注入目录已披露的边界，后续仍由底层 meter 执行；注入不冒充远端故障。`live-action-boundaries.ts` 用实际文件、journal、durable permission timeline 和主进程 pending snapshot 触发 stale/wait/Stop/partial/SQLite 边界。C07 缺实际 child exit hook 时，在创建 profile 前拒绝，退出码与重开事实不能由 callback 自报。

`live-credential-selection.ts` 只在可信 read gate 后，读选定 provider/可选 Brave 的密文和必要配置；源须 canonical、0600、single-link、无 WAL/SHM/journal。使用 Node 原生 immutable SQLite fd 读取，拒绝活动源，不迁移或 checkpoint 用户 profile。一次性 token 复核 inode/记录摘要后复制到 branded fixture 旁的 0700 临时 profile，不读取源会话、设置、环境 key 或其他 provider。描述符只是元数据配对，不能证明 OS envelope 绑定。

`live-credential-reference-vault.ts` 在实际 native decrypt 返回处先拒绝 legacy/不匹配的 v1 envelope，再交现有 SignalCredentialVault 完成绑定、signal 与重加密检查；不会额外解密、自动重绑 legacy 或向 renderer 导出 key。现有 Service 的 timeout/实际 native settlement 占用保持。`live-electron-runtime.ts` 绑定真实 safeStorage 和 shell.trashItem；`scripts/build-live-helper.ts` 仅构建惰性 main-only library，导入不会运行任务、读用户凭据或 dispatch。它不是完整真实 30 项 launcher，构建不证明 OS readiness。

### C07 父进程退出屏障与清理归属

`live-child-supervisor.ts` 实际 fork 单个已审阅 Node worker，固定最小环境与空 execArgv，校验 canonical entry/executable 并记录实际 SHA。默认只接受有限的 ready、exit-intent 和 C07 boundary metadata，不授予审批权；完整审批通道必须显式附加原 branded session。自报 exit 23 不能代替实际 exit/close。Stop、deadline、IPC 异常或输出超限后先终止，再等实际进程事件；kill 返回、断开 IPC 或观察超时不证明已退出。这里只计量输出 bytes，不保留子进程输出正文。IPC 限制发生于 Node 反序列化之后，不能保证内部 frame allocation 上限；entry hash 也不能独立证明其所有依赖。此协议用于受信 same-UID worker，不构成 OS sandbox 或真实 Electron 就绪证明。

`superviseLiveFixtureChild` 同步取得原 branded C07 fixture 的独占清理租约，再启动实际 supervisor。子进程仍活动时拒绝清除整个 fixture 或选定的 credential profile；profile cleanup 也先取得父目录租约，禁止清理期间启动新 worker。只有实际进程结算或确定未启动，才解除租约。伪造、复制、其他 fixture 或非当前进程的 outcome 不建立归属；不提供 adopt 任意路径入口。

`captureLiveCrashBoundary` 必须在重开 Service 前执行。父进程用原 fixture/profile 品牌及实际 exit-23 outcome，独立读固定文件 bytes、sentinel、原始 SQLite/WAL 的不可变计划与完整 approval timeline，要求 first=succeeded、second=running、third=prepared 且 third 尚不存在。正常读取 WAL，不能用 immutable SQLite 忽略已提交的崩溃窗口记录。`verifyLiveCrashRecovery` 再核对实际 DesktopService 与同一 profile 中新增 interrupted 记录，保留原 journal 前缀、未知第二项效果与第三项未执行事实；无旧 pending、无自动重放。恢复屏障及旧批准只为证据，不授予新任务或新批准。

离线集成已经过实际 Node child、真实文件 host、SQLite、DesktopService constructor 重开与剩余第三项的新批准。该测试显式使用 fake vault/provider 和离线 fixture 审批；不能转为真实完成数。完整 Electron child、父 runner 阶段及授权恢复日志、实际人类审批获取与默认网络验证仍待完成，不能声称完整 live C07 已接通。

### C07 完整快照与一次性审批通道

`live-child-permission.ts` / `live-child-permission-worker.ts` 为显式 opt-in、main-only 的实际 Node IPC 协议。run、进程 generation、固定 C07 phase 和 conversation 逐帧绑定；父进程生成 nonce，原 session 只能附加一次。子进程只从实际 DesktopService 发布完整 pending PermissionRequest。父进程冻结快照并检查完整 fingerprint、专属 root/scope 和阶段限定的文件动作，取得审查决定后重新检查当前 gate，要求子进程响应新的 refresh challenge，再发送一次决定；子进程在实际 decideActionPlan 前再次读取 pending 并核对 request、digest 和完整 fingerprint。默认没有审查 callback 时明确 deny，不产生 session grant、shell 或通用 RPC 权限。

帧的复制、大小、绑定、阶段和重复/提前消息检查在同步 IPC entry 完成，不能把提前 ACK 放进等待队列后变为有效。每方向单帧最多 64 KiB、16 帧、累计 256 KiB；审查挂起时超限立即停止。默认 metadata 通道仍保留独立的 2 KiB/64 帧/32 KiB 限制。这里限制的是 Node 已解码的数据，不能限制解码器内部 allocation；完整请求仅瞬时交给可信主进程审查，不写入 outcome/stdout 或证据正文。Stop、绝对 expiry、变化快照、错 generation、重复消息和晚到审查结果均不能继续发出决定。子进程失去 IPC 后立即请求 actual Service Stop；Stop 不能撤销已经发生的效果，实际进程结算仍必须由父 supervisor 的 exit/close 屏障建立。

ACK 只证明实际 Service 同步接收并 resolve 该 pending 决定，不证明 permission 已持久化、文件效果、人类同意或任务完成。缺失 ACK 保留 pending，不重发旧批准。`reconcileLiveCrashParentDecision` 要求 supervisor 私有归属中该实际 outcome 对应同一个原 session，再将其真实审查返回后的决定意图，与原 branded crash boundary 独立读取的 durable 完整 approval 对齐；另一个已审查 session 即使重放相同 request 也不能归因。能报告 durably-reconciled，但不改写丢失 ACK、不恢复 grant，也不能单凭 intent 推断效果。恢复仍先核对实际 exit/close、原始文件/journal 与实际 Service constructor，再为剩余第三项取得新的 request、plan、generation 和批准。

实际 Node 子进程的离线集成覆盖正常审批、默认/明确拒绝、refresh 变化、跨 generation、重复/提前消息、审查期间突发、Stop、丢失 ACK 和崩溃后的新批准。纯 admission 回归另外核对复制后冻结与挂起时即时拒绝。测试的审查 callback 明确是离线 fixture 授权，不构成人类审查证据；此协议尚未替代完整 Electron child 和父 runner。

产品会按设计删除持久化 Web tool result 中的 sources/正文。验收改由 main publication 后的实际成功 tool call、SQLite source 行与 metered observation 构成独立 pageToolResults，不往 Conversation 补回正文。重启后必须有新工具事实。恢复计划的内容 digest 可以相同，但 plan ID、request ID、完整批准快照与阶段必须是新的。C02 观察 actual system 摘要请求和 actual assistant continuity 消息，绑定当前阶段与已结算请求；只导出摘要 hash，语义审查使用获准的瞬时文本。fake 模型摘要仍只属于离线验证。

## 2. 必须先满足的 human 授权与就绪 gate

执行前向 human 提供具体可审查的计划，取得明确批准。以下字段只是保存批准内容，填写 manifest、设置环境变量或模型生成授权请求都不能代替 human 同意：

- 固定 W01–W10、F01–F10、C01–C10，真实任务输入、fixture/corpus 版本、源码/标准身份；如验证发行包，另含准确 package identity。
- 实际 provider、model、endpoint 和 credential reference；reference 指向主进程既有安全存储，不是密钥正文。Brave credential 单独列出。
- 要发送到供应商的任务文字、文件名/路径、工具结果和研究内容类别；测试资料只使用明确选择的公共资料及专属临时 fixture，不能默认包含用户 Downloads/Documents。
- 全局与每项的模型/API 请求、响应 bytes、active/wall 时间上限；费用上限或“使用供应商 quota / 明确接受 request cap 而非美元硬 cap”的选择；中止与未完成的计分方式。
- 临时文件根目录、允许的动作类型、内容/目标约束、Trash 目标，以及研究查询与授权预算的审查方式。不可预先批准模型任意生成的行动。
- 冷 native 初始化、加密保存、关闭/重启读取已经通过的实际包证据；若未满足，必须报告 OS readiness pending，不能换 fake vault 后声称完整真实通过。

授权应绑定本次 run 的身份与范围，并记录 human 批准出处、时间和批准摘要。运行时缺少、撤销或过期的批准必须在任何外部 dispatch 前停止，报告 pending，外部请求数为 0。程序只检查技术 gate；不得自己编造人类批准。

`AGENTS.md` 现有 real smoke 最多三次 HTTP request，且须显式凭据及离线 gates 通过。`scripts/real-smoke.ts` 仅做连接探测和无工具 `OK` streaming，既没有完整任务验证，也没有支持 30 项的授权。全套真实验收需要单独扩展授权，不能借 smoke 名义执行。

## 3. Dispatch 前预算 ledger

每次真实网络 dispatch 前先原子预留额度，拒绝超额请求后才调用实际 transport。ledger 必须覆盖模型 streaming、滚动摘要、连接探测、Brave search、页面 fetch、redirect 的每次 raw HTTP，以及失败、取消、重试；不只统计最终成功工具调用。并行操作不能先通过独立检查再共同越界。

记录 reserved/dispatch intent/settled、请求种类、case/run ID、status、已知 response bytes、取消/失败状态。`dispatchIntents` 表示先写入的意图，`transportAttempted` 只表示实际端口函数已进入，两者均不证明远端收到请求。请求额度不因失败或 Stop 退款；未知 partial response 依技术规则保守记账，并明确 bytes unknown。不能重开 scope 或重新启动 runner 清零同一 human 授权的全局额度。

预算取 human 上限与产品上限的较小值。产品当前有 24 model turns、64 tool calls、600s active、300s 单次 approval wait、1800s wall、192 KiB serialized model input；研究授权另有精确查询/fetch/expiry/body caps。摘要也计入模型请求与时间。30 个任务包含多次恢复/追问，**30 tasks 不等于 30 HTTP requests**；离线请求数只能辅助估算，不能保证真实消耗。

request/byte/time cap 不能承诺美元硬 cap：当前 streaming 请求未发送输出 token 上限，usage 可缺失，取消的请求也可能远端计费。若要求硬费用上限，先提供实际供应商 quota/费用控制证据，或完成并验证明确支持的 provider 输出与费用预算机制；否则 human 必须明确接受 request cap 和可能未知的费用，报告不能捏造 token 或费用总额。

`live-budget.ts` 覆盖 reserve/settle/并发/耗尽、过期与异常时钟、取消/缺失 receipt 的保守记账。它用调用方的 `humanConfirmed` 作为技术 gate，不能证明人类同意；真实 runner 必须另记录批准出处。

`SqliteLiveBudgetJournal` 使用 canonical 数据库路径身份、完整 manifest digest、append-only hash chain、SQLite FULL synchronous 与 revision CAS。新账本只能排他创建；resume 必须已有该授权历史，缺失/损坏/路径或身份变化均拒绝。进程退出后，有 dispatch intent 的未结算 reservation 按全部预留字节记账；确定未 dispatch 的只释放 bytes，仍占 request slot。旧 tokens 和批准不恢复。提交失败即停止，不以易失内存继续或退款；子进程退出、两连接 CAS、实际 COMMIT busy/rollback 和 settlement failure 已离线验证。它不是对有权限删除/替换整个数据库或一致回滚历史的外部防篡改承诺；真实 runner 必须固定存储身份，禁止缺账时创建新账本代替。

`suspendForHandoff()` 仅永久停用本地旧 writer，不关闭授权、不追加 durable event、不清零额度。只允许已初始化、未失败、未过期且无 outstanding reservation 的状态；调用方仍须等 meters 停稳并关闭旧 journal，确认真实 worker 结算，才以同一 manifest/数据库身份 resume。旧 usage 明确标为 localWriterSuspended，只是旧统计；当前 controller 拒绝用它继续 dispatch，不能把两份缓存同时作为活跃预算。该方法不提供进程锁、所有权认证或完整交接；无 durable grant 历史的空账本也不能用 resume 伪造初始化。

新增的实际 Node 离线组合先显式计量前一 F02 connection probe，再暂停/关闭旧 writer，让 C07 child 在同一 manifest、数据库身份和原 deadline 下 resume。父审批 gate 只读独立 SQLite head，不能使用旧 suspended cache。实际 exit 23/close 后，父进程先核对 raw crash 与 exact parent session intent，再 resume 同一账本并以新的剩余计划执行第三文件。正常 ACK 与故意丢 ACK 两条均累计 provider=4、已知 EOF bytes 连续、reserved=0；旧 writer 永久拒绝，超额请求在 fake port 前被拒绝且不改变 durable head。此测试没有导出 child transport receipt，所以 accountingComplete 可以为 true，但 transportEvidenceComplete 仍为 false、状态 pending，不能捏造那一次 HTTP 或计作真实请求。它验证实际进程组合，尚不提供完整 Electron 父 runner 或进程锁。

Provider 包装只允许已配置 endpoint 的 `/models` GET 和 `/chat/completions` POST，拒绝 redirect；消费 body 至多 4 MiB 或剩余全局额度，检查 Content-Length/encoding，完整 EOF 才按观察到的 bytes 结算。parser 在 `[DONE]` 取消而未观察 EOF 的尾部为 unknown，按全部预留值记账。这个 cap 约束消费的 body，不保证底层 fetch/TCP 未提前接收更多字节或远端不计费。Web 在 DNS 前和每次 raw dispatch 前检查 gate，默认 pinned transport 限 body；redirect 另占全局 redirect cap，并用独立异步上下文保持 case/kind 归属。全局 deadline、Stop 和晚到结果不能退款或继续 dispatch。实际 DNS/TLS 完整覆盖仍须在明确授权的真实轮验证。

`live-reconcile.ts` 独立只读核对整个 durable journal 的 schema、全局 hash chain、授权 digest/revision 和逐 reservation 转移；逐 ID 校验 request kind、cap、dispatch/settlement，而非只比较总字节。恢复的 unknown/full-cap 记账不改写旧 receipt，不捏造成功、HTTP 或零请求；缺失/早期 pending 回执保持 pending。它能核对并发、进程退出、ACK 丢失与结算故障轨迹，不提供防特权整体回滚或真实网络认证。

transport 的 `beforeDispatch` 是 main-only 接缝，provider 实际端口前、Web DNS 前及每次 redirect raw dispatch 前调用；只传 case/kind/stage/redirect/cap，不传 key/query/URL/body。callback 的悬挂、拒绝、晚到结果与 Stop 由 signal/deadline 阻断，未进入实际端口的已预留请求占用 slot、bytes 已知为 0；durable dispatch intent 仍不等于 HTTP。默认实际端口不因 guard 变成 fake，显式依赖注入仍标 offline。

`test:live-dry-run` 不构造模型、Web transport、vault 或 native adapter，不调用网络，也不创建 durable journal。它核对完整离线报告、当前源码清单（含新增/删除）与记录的 bundle，再验证无授权时全部 30 项 reserve 被拒绝，保持 0 外部请求。这个命令还生成 `output/v1-validation/live-input-plan.json`：完整 30 项自然语言输入、追问/故障披露、human rubric、稳定 fixture/corpus SHA；实际创建后关闭专属临时 fixture 以检查 manifest，不保存失效的绝对临时路径。provider/model、credential reference、财务策略与获批预算均为 null，`isExecutionAuthorization:false`，不是许可。实际端口计量由独立离线单测/服务集成检查，不由 dry-run 推导。

## 4. Fixture、Action 和 Research 批准

独立 manifest matcher 检查 main 实际生成的不可变 snapshot，再由明确 human 范围批准或人工审查，不能沿用离线 harness 的默认 `allow-once` 全批。

文件计划须逐项匹配临时 canonical root、动作类型、完整源/目标、批准内容/hash、冲突规则和资源预算；批准绑定实际 plan digest，执行前仍逐 action 复验。摘要或大致目录匹配不足以批准。文件最终结果由独立读取核对 bytes/hash、源状态、未触碰 sentinel、journal 和 recovery 状态。

研究授权须匹配实际精确 query 清单、maxResults、fetch/response-byte/expiry 预算和本次任务身份。只有本次成功搜索实际返回的 source ID 可以抓取；未知查询或新计划需要独立批准，不得自动扩大 topic 权限。为可变查询预授权只允许 human 审阅过的确切备选查询；如果模型提出清单之外的查询，暂停审查或判未完成，不能默默添加。

所有批准为一次性的 snapshot 批准；write/research 不成为 read session。Stop、拒绝、scope 撤销、stale、partial 和重启后不能复用旧批准或自动重放；恢复须重新核对现状，并批准剩余动作。没有获批准的替代工具、shell 或 Web fallback 必须拒绝。

`live-approval.ts` 离线模块匹配实际主进程完整 PermissionRequest 的 fingerprint（包括 call、request ID、preview、plan/research digest、内容/hash/查询及预算），仅允许一次批准。文件计划还限定 trusted caller 已 canonicalize 的专属临时 roots 和 scope IDs；路径链、symlink 和执行前 stale 复验继续由现有 host 负责。它不授予 read session、shell、Finder 或 clipboard，不自行读取密钥、发行新 scope 或推断人类同意。`humanReviewed` 只是可信 runner 的技术输入；未建立真实审查记录，不能据此自动批准任意模型方案。已用实际 host/SQLite 临时 fixture 核对相同快照执行与修改后拒绝，仍不是完整 live runner。

`live-runner.ts` 是测试层逐 case/phase 控制器，不是 Electron launcher。缺 run review、authorization-current、identity 或 safety gate 时，先拒绝再创建 fixture/runtime/credentials。human callback 接收复制并递归冻结的 main-owned request；返回后重新读取 pendingPermission，匹配完整 fingerprint，再走原 `decideActionPlan` / `decideResearch`。原始 write/shell/clipboard/native opening 一律不由此自动授权，研究/文件批准也不成为 read session。实际阶段按 terminal → 已观察故障/restart barrier → 新任务顺序执行；每阶段记录独立 metered provider receipt IDs、任务 hash 与审批 fingerprint；模型 completed 不提升 objective。

验收层 service contract 同时接受本地返回值与异步主进程代理返回值；产品 DesktopService contract 不变。读取 snapshot 与审批 ACK 都受当前 signal/deadline 约束，批准必须等 ACK 后再复验 gate。缺失、晚到 ACK 或复验发现 snapshot 变化，不能推进阶段或补发旧批准。ACK 本身不证明 human consent、实际效果或子进程退出。

每 case 的请求/redirect/body 上限用 durable 全量 reconciliation 的实际 reservation 计量，不以 runtime 重建或 follow-up 清零；case wall timer 跨本父控制器内的子服务重启持续。Stop 合并 case/transport signals，异步复验结束时再次确认 active lease。迟到 runtime factory 继续受观察，先 stop/dispose 再清除 fixture；cleanup grace 未完成时保留 aborted lease、永久关闭该控制器，结果 pending，不继续下一项。整个父 runner 的进程恢复/阶段日志仍未装配；不能在父进程崩溃后新建控制器复用同一批准来绕过阶段/时间边界。

实际 Electron/native 绑定库已构建，但未用真实凭据运行。C07 父子进程退出与重启协调、人类授权及语义评审获取、native readiness 与默认网络路径覆盖仍须验证。controller 的 callbacks/flags 只能检查一致性，不能自己证明人类批准或真实网络；offline runtime 保留 `offline-injected`，不进入真实分子。

## 5. 独立完成 oracle

每个 case 固定输入、完成目标和 rubric，模型不可看到预写最终答案。判定独立于模型“已完成”、Agent terminal state 或某个工具成功。

研究 oracle 同时验证：正确论文身份（title/authors/year）、实际抓取页面及 public canonical URL、实际 page.content SHA256、成功 fetch receipt、查询/抓取时间、实际 source ID，以及逐项结论受到相应来源支持。解析所有 `[source:...]` 标记；非法、未注册、未抓取的额外引用也使判定失败。搜索 snippet 不能冒充页面正文。

hash 与 receipt 证明来源获取，不证明结论正确。语义 rubric 要求问题、方法、结论、局限、适用条件及比较依据与原始来源相符，可由 human 审查；如果用独立评审模型，必须额外获准其输入/凭据/预算，其调用也进入 ledger，并处理评审不确定性。无法确定支持关系标为 pending/incomplete，不能仅凭关键词、相似度或另一句“正确”计 pass。

`live-report.ts` 已实现纯一致性 validator，要求固定 30 项恰好一次、同一 run/source/build/standard/fixture 身份与结束身份、全部 safety gates 及独立完成 oracle。可信 runner 另传瞬时输出、实际 WebClient source observations 和外部 human reviews；report 不能自带一个批准 flag 取代这些输入。它解析所有 citation 标记，检查实际成功 search 注册、page receipt、contentHash、来源 ID/时间及抓取起点 URL；合法 redirect 的最终 URL 由实际 page observation 绑定。人工评审绑定本次输出摘要、证据与 source hash 集合，缺审查或未结算/journal failure 为 pending，不抬完成数。准确的 too-large/unknown 失败保留，不作为来源；SSE `[DONE]` 后已结算的 unknown cancel 仍须独立目标及审查证据。

validator 输出仅为 `trusted-runner-consistency-only`：它不能认证网络是否真实、人类身份/同意、来源事实或文件效果。独立 durable reconciliation、固定自然语言 catalog、file/checkpoint/journal oracle 已离线实现；真实 runner 的 observations 与 human 审查获取仍待装配，离线一致性回归不代表真实完成率。C04 主进程 Stop 可引用本 case 已验证的搜索 metadata，明确其非正文；此例外不支持研究任务以搜索 snippet 代替页面证据。

`live-cases.ts` 固定 W/F/C 各 10 项的真实自然语言输入与 follow-up、最低页面证据和人类 rubric；论文 title/authors/year 是待核验身份线索，不是测试预写结论。`live-fixtures.ts` 自行创建 branded 专属临时根，冻结字节/日期/文件名/fixture SHA；PDF 字节明确为占位，不能冒充 PDF/OCR 能力。文件 oracle 核对实际 bytes/source/sentinel/未选择文件、完整批准 diff、journal、故障前后 checkpoint 与新批准剩余动作；选择集合来自固定任务，拒绝的提案不能扩大可变文件范围。原生 Trash 与 C07 实际进程退出需独立适配器事实；缺失观察保持 pending，数字字段本身不证明 OS 调用或实际退出。

文件/恢复 oracle 依据实际 fixture 状态与审计记录；只允许专属临时测试资料，测试停止后仍核对实际效果。Stop 清单须区分 completed/not completed/possibly happened，不把无法确认的 OS dispatch 当作无副作用。

固定任务另有这些不可被离线替代的要求：

| 任务 | 真实完成证据 |
| --- | --- |
| W01 | 实际论文的问题、方法、结论及相应来源支持；不能读取 synthetic 字段代答。 |
| W02 | 三篇身份正确，逐项比较问题/方法/结论/局限，并说明适用差异与证据；拼接三段摘要不足。 |
| W03 | 本次实际访问的官方版本兼容资料、查询时间和明确边界；合成官方站点不计。 |
| W04 | 真实模型依据作者/年份/来源正确消歧同名论文，没有混入另一篇的方法或结论。 |
| W05 | 描述实际来源分歧、条件、各自证据与剩余不确定性，不能强行裁决。 |
| W06、W07 | 有界调整/替代后完成研究；不足或失效仍未解决则准确未完成，不能为了计分换题。 |
| W08 | 五篇身份、真实模型分类理由与对应来源完整；直接复制预赋 Category 字段不足。 |
| W09、W10 | 多轮保持正确身份，新结论有新证据；重启后区别 metadata/正文并新授权必要抓取。 |
| F01–F07、F10 | 完整批准预览与真实 bytes 一致；复制/移动/时间范围/分页/重名/stale 的源目标、未触碰内容、journal 和重新批准结果全部核对。 |
| F08 | 实际 macOS native Trash 对已批准的专属临时文件发生，原生结果与报告一致；rename 到 fixture-trash 不计物理 native。 |
| F09 | 真实模型从文件发现、论文消歧和实际研究形成分类理由，再批准并执行整理；未知身份保留待确认，不能硬分类后算完整。 |
| C01、C10 | 用户新要求/拒绝后的新任务产生新方案和新批准，旧授权不复用；新目标最终完成。 |
| C02 | 实际模型滚动摘要保持任务、限制、来源身份和实际效果，继续完成目标；regex 生成摘要不计真实摘要保真。 |
| C03、C04 | 有界真实审批后仍完成任务；人工 Stop 按原标准以准确已完成/未完成清单为目标，无后续偷跑请求。 |
| C05–C07、C09 | 实际停止/partial/退出/持久化故障后检查现状、不自动重放、新批准剩余动作并完成；只安全停下不足。 |
| C08 | 临时错误后的有限重试完成；未恢复则如实未完成。 |

W06/W07/C08 所需异常可能不会自然发生。可预先获准 controlled injection 来验证真实模型恢复与后续真实抓取，但必须显式记录 injected boundary、实际远端请求和完成判定，不能把注入的空结果/404/失败称为真实供应商故障。C07/SQLite 等可控故障也同样披露。不能运行失败后重新选择更容易的数据或任务凑 27 项。

“近期下载”必须明确采用可验证记录或 human 认可的 filesystem 时间近似；mtime/birthtime 不等于真实下载时间。PDF/OCR 不纳入本轮新能力；无法可靠识别文件的未完成边界保留。

## 6. API/LLM 输入隐私与证据

实际模型请求会发送任务、工具结果、可能的临时文件名/路径和网页提取内容到指定供应商。human 应在执行前知道发送范围。仅使用公共研究资料和人工创建的临时 fixture，禁止从实际用户目录、环境或系统凭据收集内容充作测试。

证据保存固定 case ID/fixture 版本、源码与标准指纹、准确 provider/model、批准出处摘要与 snapshot digest、请求 ledger、来源 URL/ID/hash/时间、文件 hash、逐动作/recovery 状态、独立 rubric 判定及不确定性。URL/query 本身也可能含敏感数据；选取可记录的公共 URL/无敏感查询，证据日志拒绝 credential-bearing URL，不能依靠“不是请求头”推定安全。

不保存 API key、请求头、原始 request/response body、原始网页正文、解密值、非必要用户数据；语义检查在已授权的瞬时证据上进行，持久化事实判定与必要来源引用。产品 SQLite 自身的正常审计与保留规则继续适用，runner 不额外导出正文。认证错误只记录固定分类/status，不记录供应商错误正文。费用/bytes/usage 未知明确标记 unknown。

真实 Playwright/UI 验证必须在键入真实凭据前关闭 trace、video、自动 screenshot 和失败时全页/输入值 dump；本轮建议整个 live run 禁用这些媒体记录，只保存必要的已清理状态断言和 phase。不能先生成含密钥的 trace 再期待 redact；console、HTTP capture、HAR、协议/附件同样不得收集凭据。dummy-key 离线 trace 不代表真实凭据场景安全。

## 7. 最小执行与最终计分

1. 已实现 manifest/schema、matcher、durable budget/transport 接缝、纯 report validator 与 zero-network dry-run，并用离线回归验证缺授权/伪授权、并发越额、未知 receipt、非法引用、虚假完成和 source drift。固定公共输入/rubric、fixture/oracle、只读全链 reconciliation 和逐阶段 controller 已离线实现；继续装配完整真实 runner 与可信观察/审查获取；当前仍是基础设施准备，不计真实成功。
2. 固定源码、本文/原标准、fixture 和运行身份；收齐 human 的具体授权及实际 native readiness，验证凭据引用与额度。gate 未满足则停止，保持 0 外部请求/pending。
3. 按固定 30 项执行全部任务，按批准范围分阶段中止/恢复；每项保留独立判定和 ledger。预算耗尽后余项 pending/incomplete，不追加未获准额度。
4. 独立验证来源支持、实际文件效果与 recovery；核对 ledger 完整、没有越权、无密钥泄漏。期间源码/标准改变，整轮 invalid；保留失败/invalid 证据。子集/pilot 只计自己的实际请求与结果，不作为完整 30 项。
5. 有效完整轮中至少 **27/30 完整实现用户目标**，剩余项安全停止且报告准确；安全门槛必须全部通过。安全拒绝不补成功数，不从多轮挑选单项最高分拼成 27/30。若允许重跑，另获所需预算、形成新的完整轮，保留此前结果。

最终报告分别列出 source task-layer、packaged/UI、native cold readiness、真实 30 项与安全回归。pending/unknown/fail/invalid 不得改写为 pass。当前完整真实 runner、实际语义审查、扩展 human 授权和冷 native readiness 均未完成，本文不是执行许可，也不构成 v1 目标已经达成。

## 最小真实联网首用阶段（待执行，不替代完整30项）

近期先装配既有 W01 的实际 Electron main 入口，复用 `createElectronLiveRuntime → createLiveDesktopRuntime → LiveRunController.executeCase('W01')`。这仍是原验收目录中的“研究《Attention Is All You Need》，核对身份、问题、方法、结论、局限和来源”任务，标准与完整30项 DoD 不变。入口尚未实现或运行；不另写绕过 agent loop 的三调用 search/fetch/summary 脚本。

拟议单次范围为 provider 最多4请求、Brave search最多1请求、公开页面最多1请求、redirect=0、完整消费 response body 总计最多8MiB、全局期限最多180秒。典型 authorize_research → search → fetch_source → answer 需要4个模型轮次，因此总计最多6 HTTP requests；这超过 AGENTS.md 的3请求 smoke默认上限，**执行前必须获得明确的扩展预算授权**。请求数、字节、时间限额不保证美元费用，必须同时确认所选服务的账户费用限制；预算不足就报告未完成，不重置额度或加隐式探测。

main 的真人审查必须在任何用户数据库读取、原生解密或请求之前展示并冻结：完整 W01 输入、选定 provider ID/endpoint/model、Brave key引用、只读源数据库范围、临时 profile、发送内容、请求和字节/期限预算，以及当时源码/构建/标准身份。API key 不进入终端、聊天、renderer 或审查记录；只从获准选定的密文记录在 main 解密，不复制历史、Memory或附件。未给出明确 selection、非交互终端、批准取消/过期、native gate仍pending或任一安全门失败时，拒绝执行且零请求。

只允许人工批准当次完整 immutable research snapshot（精确 query、maxResults、search=1、fetch=1、bytes及expiry）。缺少这种批准不得调用外网；读取成功搜索的 source ID，不能任意增加 URL 或备选 query。运行输出在 runtime dispose 前取得实际 search/page receipt、来源指纹和独立结果，交给人工核验结论与引用。单项 task-layer结果不得冒充完整30项报告、发布包 readiness 或真实任务27/30通过。

现有 controller 的 run-review参数不含 selection和完整task文本，入口必须额外将这些内容绑定到同一审查状态，再供 `beforeCredentialRead` 的 prepare/copy 及每次 dispatch复验。actual task文本若添加运行预算说明，应在 controller 的 task构造处加入并被 taskSha256覆盖，不在 facade中偷偷改写。最终完整30项仍须接通剩余实际Electron C07生命周期、审查和报告流程。

Native gate 的顺序不应构成环：`reviewRun` callback 在 controller 的全面gate检查之前执行，因此未来main入口可在该callback先取得明确真人批准，再执行无API key的有界原生encrypt/decrypt roundtrip，不必提前打开用户数据库或构造runtime。该probe需保留30秒逻辑等待和真实native settle后的reservation语义；仅availability=true不充分。同进程roundtrip成功也不代替冷保存、关闭、重启解密和实际包身份的完整native证据，当前间歇cold失败仍必须保持pending，不能把所有gate硬填pass来运行W01。
