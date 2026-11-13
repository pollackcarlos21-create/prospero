# ADR-008: Opt-in runtime suspension

状态：core 原语及 Dot exact resume 已通过离线回归，并接入正式 Web 研究与审批 UI，见 ADR-009/010。日期：2026-10-19。

## 决定

保留 `runAgent(AgentOptions): Promise<AgentOutcome>` 的 Chat 默认等待、超时、取消及 cleanup 行为。只有传入 `suspension` 的调用方可以使用 `SuspendablePermissionPort` 返回 `suspend`，获得独立的 `SuspendedAgentOutcome`。不创建第二个 agent loop，也不保存 Promise、PreparedTool、ModelPort、AbortSignal 或 session grant。

Host 必须显式实现 `PreparedTool.onSuspended()`，释放本次 preparation 的临时资源而不记录取消或 dispatch。没有该接缝的工具 fail closed。挂起前已经完成的工具保留原结果；当前工具增加固定的“等待批准、尚未执行”占位结果；同一 response 中后续未执行工具增加固定 skipped 结果。所有公开 history 保持 tool-call/result 配对，挂起不伪装 deny/cancel，亦不制造执行成功。

## 继续点与预算

Core 返回 versioned、有界、严格校验并冻结的 `AgentContinuation`，包含 execution ID、完整配对 history、唯一待处理调用的位置、累计 model/tool counters、剩余 active time、绝对 wall deadline、既有 denial barriers、source receipts 和 untrusted memory。最多 1 MiB；不能安全序列化时终止并执行既有失败 cleanup。返回的 permission request 只供 host 创建自己的可信 immutable intent，continuation 本身不授予权限。

再次调用同一个 `runAgent`，传入匹配 execution ID 的 continuation，重新 prepare 唯一待处理调用，再次经过 permission decision。Core 仅替换其已验证的占位结果，不重新运行成功前缀，也不执行已跳过后缀；后缀若仍需要，须由模型提出新请求。旧 grants 不恢复，denial barriers 保留。原先已计数的 pending call 不重复计费，后续请求继续累计；新 limits 只允许收紧。等待审批消耗绝对 wall deadline；倒退时钟、耗尽预算或非法 history 都在任何 host/model 调用前拒绝。

## Application 责任

持久审批仍须由 main 保存 Dot/Run、provider/endpoint、policy revision、确切 call/preview digest、expiry 和 continuation 的绑定；批准后重新 prepare/revalidate，消费与 dispatch 必须持久记录。变化必须重新批准，dispatch 后未知结果不得自动重放。Core 的类型/校验不能证明数据库未被改写，也不能代替 host 的权限或副作用账本。Chat 不选择此模式，现有 host 无需实现挂起 hook。

## 验证

专项验证默认 Chat 不变、成功前缀只执行一次、后缀明确跳过、JSON 往返后继续同一调用、fresh prepare/permission、无旧 grants、denial 保留、时钟/累计预算、非法继续点零 I/O、挂起 hook 失败与 Stop cleanup。随后运行完整质量门和 Electron E2E。
