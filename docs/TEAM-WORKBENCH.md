# 多 agent 桌面工作台

日期：2026-10-18。源码目录：`/Users/chadrayfoo/Projects/prospero`。

## 已实现的使用流程

输入框的团队图标默认开启，可切换为单 agent 模式。主 agent 使用当前配置的模型，通过 `collaborate` 提交明确的任务分工。用户先看到成员名称、任务内容与模型额度提示，确认后同批子 agent 并行执行。每批 1–3 个，每个用户请求累计最多 6 个，不允许嵌套派发。主 agent 是否派发及如何拆分，由模型根据任务决定。

子 agent 复用 `core.runAgent`、当前模型、主任务的文件范围、主进程凭据和原有工具体系。每个成员拥有独立的消息、工具结果、审批、执行 journal 和终态。凭据仅保存在 main 的运行对象中，复用已完成的初始化结果，避免并行请求竞争系统凭据操作锁。

团队面板显示各成员的执行状态。展开成员可查看执行记录、处理其审批、单独停止。停止主任务会取消全部成员，并等待成员清理完成后释放主任务。批次返回带状态的报告和实际来源记录，主 agent 汇总结果；下一批收到之前的团队报告。失败、取消和中断始终保留原状态。历史成员保留在所属主任务下，重启后保留记录且不自动执行；删除主任务同时删除其成员记录。

## 界面

- 工作台支持 Light/Dark/System；侧栏 50% 透明模糊，Prospero 品牌由 14px 改为 21px。
- 图标按钮无边框；使用黑色逐渐淡出的柔和阴影、白色光晕和大圆角表达轮廓。
- 新任务、设置、文件访问与停止操作减少常驻文字，保留 accessible name、必要说明及任务审批内容。
- 团队功能按钮保留 SVG 图标，Prospero 品牌图像移除。用户消息靠右、模型消息靠左，耗时来自 host timeline；团队总记录与成员记录分别可展开收起。蓝/绿/红灯同时附带可见状态文字。内部执行提示不出现在产品对话中。
- 设置中的 Appearance 同时控制 renderer 与原生控件外观。2026-10-18 新版证据与 Dots 后续实施见 [DOTS-DELIVERY](DOTS-DELIVERY.md)；下文先前包验证仍按当时快照保留。

## 执行与权限边界

一个主任务同时持有运行入口，内部最多 3 个成员并行。主任务保留原有 24 次模型轮转、64 次工具调用上限；每个成员最多 8 次模型轮转、16 次工具调用。时间、输出与上下文限制复用原有执行循环，主任务时间限制也约束等待子任务的过程。

派发确认仅启动指定任务。子 agent 的文件变更、shell、Action Plan 和网页研究继续使用原有完整预览与审批。各成员的审批通过自身 conversation ID 路由，Action Plan / Research scope 仍校验 digest。团队共享拒绝状态；某个审批被拒绝后，同次任务后续的工具准备和尚未执行的操作会被阻止，不能改由其他成员重试。已经开始的操作仍按原有执行及取消规则收尾。

文件范围由各成员复制引用，所有变更继续经过现有身份、symlink 和 stale-write 检查。这是应用级控制；多个成员不是隔离的操作系统进程或 Git 工作树。当前成员使用同一模型，报告以批次结果共享，支持后续批次使用此前结果。

## 验证

- `bun run typecheck`、`bun run lint`、`bun run format:check`、`git diff --check`。
- `bun test`：974 pass，0 fail，6518 assertions。新增测试覆盖并行时确实同时处于模型请求、汇总时包含双方报告、凭据只读取一次、无嵌套工具、额度与参数校验、团队拒绝传播、单独/联动取消、失败状态、恢复层级、级联删除及子 agent 审批路由。追加集成测试验证两个成员独立审批后分别写出真实文件，第三个成员读取两份文件并使用前两者报告；先批准一个成员不会批准另一个成员。
- `bun run test:acceptance`：原有 30 项离线任务回归，模型、Web 和 native ports 均为明确标注的测试替身。
- `bun run test:e2e`：22 项真实 Electron 测试回归；本轮补齐团队文件/消息菜单入口后，相关完整任务和原生菜单的 2 项 E2E 再次通过（`output/team-context-actions-e2e.log`）。模型服务位于本机，覆盖 typed preload、审批、取消、重启、原生窗口及 Web fixture。
- Playwright CLI 通过本机 CDP 连接真实 Electron，检查团队派发预览、运行中成员、取消、终态及布局。截图保存在 `output/playwright/`。
- `bun run package`：生成 macOS arm64 `.app`，本地 ad-hoc 签名校验通过。打包版另运行完整任务与原生窗口 E2E；复验结果及原生凭据异常见下文。

具体日志位于 `output/team-unit-tests.log`、`output/team-e2e-final.log`、`output/team-acceptance.log`、`output/team-security-audit.json` 与 `output/team-package.log`、`output/team-packaged-e2e.log`。生成的 macOS 应用为 `release/Prospero-darwin-arm64/Prospero.app`。

这些记录验证本地执行与测试服务交互。真实模型的拆分质量、报告可靠性及实际费用仍需真实服务验收。本次没有调用真实模型或搜索 API，也没有修改用户凭据配置；源码保持未暂存、未提交、未推送。

## 打包版工作台验证

上一轮使用当时生成的 `.app` 和无需 API key 的本机模型测试服务，通过真实 preload/IPC 启动团队、批准派发、并行运行与单独停止成员。最终主任务为 `completed`，Research 为 `cancelled`、Review 为 `completed`；汇总文本保留两种状态。服务配置 `hasApiKey: false`，工作台底色实测为 `rgb(255, 255, 255)`。本项验证不需要系统凭据存取，也不证明钥匙串功能可用。截图为 `output/playwright/team-packaged-completed.png`。

## 打包版复验异常

最终包第一次两项复验中，原生窗口测试通过，完整任务测试在保存测试凭据时超时。Trace 确认窗口及设置已正常打开、连接本机模型测试成功；`safeStorage.isAsyncEncryptionAvailable()` 已开始但没有返回，尚未进入加密。主进程仍有 heartbeat。本次原生凭据失败保存在 `output/team-packaged-e2e-initial-failure.log`、`output/team-packaged-initial-failure-trace.zip` 与 `output/team-packaged-initial-credential-phases.json`。没有降低凭据保护或用明文存储绕过。

同一应用的再次复验得到相同结果：原生窗口通过，凭据保存未通过，日志保存在 `output/team-packaged-e2e.log`。系统 SecurityAgent 进程同时出现，可能需要用户处理系统钥匙串访问提示；不能凭此确认用户已授权。该次结果按失败保留。测试服务的通过也不能替代真实模型与人机验收。

## 参考

用户确认本次对齐桌面工作台中的任务拆分、并行子 agent、共享结果、取消与状态展示。参考 [DeepSeek Harness 官方介绍](https://www.deepseek.com/en/harness/) 中的 agent teams、subagents 和执行轨迹能力，执行引擎仍由 Prospero 自身提供。


## 系统状态恢复后的最终复验

2026-10-18，同一最终打包版的系统查询随后正常返回，隔离窗口显示测试密钥已安全保存，无错误提示。只读检查确认该测试配置包含 1 条 179 字节密文记录，数据库及 WAL 未出现测试密钥明文；证据为 `output/team-packaged-keychain-recovered.json` 和 `output/playwright/packaged-keychain-saved.png`。没有修改凭据加密逻辑或降低保护要求。无法仅凭这个结果确定此前系统查询延迟的具体原因。

在这一状态变化后，使用同一应用重新执行完整任务与原生窗口 E2E，2/2 通过，包含真实 `safeStorage` 加密、解密、测试服务请求、审批、文件操作、凭据不泄露、持久化和重启。日志为 `output/team-packaged-e2e-after-keychain.log`。此前的两次失败日志和 trace 继续保留；不能将这次恢复表述为对 macOS 行为的普遍保证。当前没有待处理的系统凭据验收阻塞。

## 原始要求逐项复核

| 要求 | 当前证据 | 结果 |
| --- | --- | --- |
| 纯白底色、减少常驻文字 | `styles.css` 的白色表面与 renderer 的图标入口；打包版实时样式、界面截图 | 通过 |
| 图标无框线、黑白渐变光晕、大圆角 | 打包版实时检查所有 `.icon-button` 边框为 0；`--shadow-composer`、渐变与 32px panel radius；截图检查 | 通过 |
| 主 agent 拆分任务与并行子 agent | `collaborate` schema、main-owned delegate；测试中两个成员同时请求模型，且独立等待审批 | 通过 |
| 多 agent 共享结果 | 两成员实际写入文件，第三成员读取文件并获得此前报告；主 agent 汇总带状态的报告 | 通过 |
| 取消与执行状态可见 | 单独取消、主任务联动取消、失败及恢复测试；团队面板与打包版运行记录 | 通过 |
| 桌面工具、审批与可查看产物 | 独立文件写入审批集成测试；团队文件/消息菜单按成员 ID 路由；30 项工具验收及原生菜单 E2E | 通过 |
| 当前构建与质量检查 | typecheck/lint/format/diff check、974 项测试、完整 22 项 Electron 回归与菜单改动后 2 项复验、最终打包版 2 项复验、安全审计 144 文件无发现、签名校验 | 通过 |

真实模型的任务拆分质量和真实服务费用没有在本次测试中测量。当前完成的是用户确认的桌面工作台与多 agent 协作实现；执行记录持续区分测试服务证据与真实服务证据。
