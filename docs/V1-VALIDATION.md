# Prospero v1.0 增量验证记录

日期：2026-10-06。版本仍为 0.2.0。用户亲自试用后确认产品可以联网，并明确接受本轮目标、要求上传 GitHub。该人工试用没有记录逐项问题与来源，不计为固定真实任务成绩；固定真实任务仍为 **0/30，pending**。标准见 [V1-ACCEPTANCE](V1-ACCEPTANCE.md)，完整真实整轮与本次小试用的边界见 [V1-REAL-VALIDATION](V1-REAL-VALIDATION.md)。

## 本轮交付：Tavily 正常产品接线与 DeepSeek 兼容

Settings → Web Search 新增 Brave Search / Tavily 选择。两种搜索 adapter 实现既有 `WebClient`，正常任务仍走 DesktopService、agent loop、main-owned 研究批准、搜索、独立页面读取和可点击 Sources/citation。没有增加另一套产品入口或重写 UI。

- Tavily 固定 POST `https://api.tavily.com/search`，Bearer 只发往该 endpoint；使用 basic，关闭 answer/raw_content/auto_parameters。unsafe URL 过滤，搜索摘要保持 search kind，不能冒充 page body。432/433 与 429 归入安全 rate-limit 状态。
- 搜索 provider、独立 credential ID 和 endpoint 绑定在任务初始化时读取；旧设置缺 provider 默认 Brave。切换不回退另一 key；删除一个不删除另一个。配置、读取、连接测试共用原有 Web reservation，晚到 native 结果不能恢复执行。
- Test Connection 使用所选供应商及固定 `Prospero web search` 查询，一次请求、一个结果，不保存 draft 配置、key 或来源。UI 切换时清除输入 key、测试结果和删除确认。
- 官方 DeepSeek 的 root/v1/beta 与当前 `deepseek-flash` / `deepseek-v4-pro` 显式非 thinking；当前 ModelPort 不回传私有 reasoning_content，避免多轮工具协议缺字段。其他 endpoint/model 不注入该参数。
- 页面继续采用全部 DNS answers 校验、地址 pinning、TLS、逐跳 redirect、HTML 提取、大小与时间限制；GET 无认证/body。Web transport 新增有限 main-only POST，request body 限 16 KiB。core、ModelPort、研究快照、SQLite schema 和权限契约未扩展；tool 描述改为所选搜索供应商。

## 当前验证

| Gate | 当前结果与范围 |
| --- | --- |
| typecheck / lint / format:check | pass；lint 167 files、0 warnings；format 165 files |
| unit | **822 pass / 0 fail**；4937 assertions，58 files，23.81s |
| security:audit | 124 files，0 findings；静态检查 |
| 固定完整 30 项离线任务 | **30/30 pass**；W/F/C 各 10；当前源码在运行期间未改变 |
| 完整 development Electron E2E | **22/22 pass**，1.8m；包含 Brave/Tavily 批准、网页来源、点击引用与重启 |
| 最终 bundle Web E2E | **2/2 pass**，6.2s；在 supplier-neutral tool 文案及 Tavily quota 分类收尾、重新构建后再验两个正常 Web 用例，与 22 项重叠 |
| 最终 build / package / byte identity | pass；6/6 dist 与 ASAR 相同；strict 验签通过；本地 ad-hoc，非 Developer ID / notarized |
| 最终签名包 packaged E2E | **15/15 pass**，1.5m；正常 Web fixture 的 7 项不计 packaged 测试；同包前两轮失败记录保留 |
| 真实固定任务 / CI / 发布认证 | **0/30**；CI 未运行，Developer ID / notarization 未具备 |

完整 development 22 项基于收尾前的生产 bundle；最后两处小修改是 tool 文案与 432/433 分类，最终 bundle 的 Web 用例另列，不能拼成 24 个不同任务。离线 unit/integration 验证 Tavily POST/body/result/error、页面无认证、研究拒绝零 DNS/HTTP、独立凭据/endpoint、legacy Brave 和 draft Test Connection 不保存。开发桌面 Web 测试明确替换 DNS/HTTP、native crypto 与 browser opening，不证明实际 Keychain 或网络可达。

单查询桌面用例在同一界面一次批准，实际搜索 source ID 驱动页面读取并展示 page citation；重启保留 supplier、来源 metadata 与空 key 输入，stored Test Connection 经主进程读取相应 synthetic key，旧批准不恢复。公开 conversation/SQLite 不保存 key 或页面全文。其 fake model 四轮调用不代表真实模型质量。

固定离线整轮仍使用 164 次 fake model HTTP、51 次 fake Web 尝试（26 search、25 fetch）、53 次 task run。任务 runner 直接运行 TypeScript，不使用发行包；F08 不证明实际 macOS Trash。完整 30 项仍以 Brave fixture 运行，Tavily 由另列 adapter/product 测试覆盖。

## 授权小试用与后续人工验收

Human 明确提供 Tavily/DeepSeek 凭据并要求一两个真实小问题，不再要求预算确认。总计 **3 次实际业务 HTTP**：Tavily 两次、DeepSeek 一次，均 HTTP 200；第一个 Tavily basic 查询返回 3 个 arXiv 结果、1 credit。DeepSeek 使用实际非 thinking `deepseek-flash`，返回一句 self-attention 说明，input/output 为 451/28 tokens。

论文研究尝试没有完成：首次临时脚本未识别 arXiv 的 www/export 别名；修正选择后，实际默认 safe fetch 发现 `www.arxiv.org` 的系统 DNS 返回 `fc00::9b6` 与 `198.18.6.230`，按设计 blocked-address，在 HTTP 前停止。另一次临时 search-snippet 脚本遇到 blocked URL 后没有调用模型；正式 adapter 会过滤 unsafe URL，已有离线回归。没有把搜索摘要或模型记忆充当网页全文，也没有放宽保留地址检查。

当时补充核对：`api.tavily.com` 的系统 DNS 也返回 `fc00::9ad` / `198.18.6.221`；该次观察下默认安全搜索在 HTTP 前停止。这是历史诊断结果。随后用户在 2026-10-06 亲自试用，确认产品已经可以联网，并明确本轮目标已达成；本次按该人工验收上传，不再把此前网络观察作为当前交付阻塞。没有为此放宽安全地址检查。

这些是直接 API/组件 smoke，不经过正常 DesktopService/UI/agent-loop，不计固定真实任务；Tavily/DeepSeek key 可用不等于当前电脑能完成默认产品网页研究。没有持久化真实 key、原始搜索响应、网页 body 或用户文件。试用记录在本地 `output/v1-validation/deepseek-first-use/`，包括未完成尝试，不能只挑 HTTP 200 结果；这些材料不随源码上传。

## 原生凭据与历史失败

当前同一最终包三轮完整回归分别为 14/15、14/15、15/15。第一轮凭据检查实际 13.397s 后 settle 并 encrypt，provider 在关闭前已保存；10s 成功断言先失败。成功断言调整为 35s，以覆盖未改变的 30s 产品 deadline。第二轮共享 helper 的改动使故意 pending 的 fixture 到 35s 才进入原 32s 观察窗口，诊断结果 pending；该 fixture 恢复显式 10s 早失败后观察。第三轮完整 15 项通过，前两轮原日志/trace/phase 保留，没有将其拼成一次通过。产品代码、包字节、native 方法、OS 期限均未因这两个测试修正改变。

此前和当前桌面回归使用独立临时 profile；模型 key 与独立 Brave key 的 packaged 用例保留真实 OS-backed safeStorage。Web fixture 中 Tavily 的保存/重启使用 synthetic native ports，不能由此声称真实 Tavily 冷首次 Keychain 已验收。

历史包首次 native availability started 后没有 settle，未进入 encrypt，main heartbeat 仍活跃；原 10 秒断言失败，约 30.19 秒观察到公开 deadline。原包完整结果为 13 pass / 2 fail，另有两个 worker teardown errors；失败材料与原 archive 95137c782fce16103674cbd5eed6e99f11880b293fe66efd08fa390e6b6a0407 绑定并保留。后来 package15 与当前场景通过不能证明跨安装、重签或其他 OS 授权状态稳定；根因仍未知。

## 证据与剩余工作

本轮日志、最终 package identity、最终 Web report 与 packaged report 保存在本地 `output/v1-validation/tavily-integration/`，不随源码上传。完整 22 项的旧 package identity 保存在 `before-final-refinement/`；更新前 root 证据在 `before-evidence-update/`。该整轮的顶层 evidence、source/bundle manifests 与 acceptance status 已更新；其 source manifest 记录上传前文档收尾之前的源码快照。SHA 只绑定材料，不单独证明正确性。

固定真实整轮至少 27/30 完整完成的标准保留为后续正式 v1.0 验证；本次人工联网验收不扩展为整轮。native Trash、完整父 runner 和独立语义审查仍未完成。本轮未安装依赖、访问用户 Downloads/Documents、修改 OS 网络设置、批准 OS 弹窗或重置 Keychain。用户已明确授权将当前源码、测试及文档提交并上传 GitHub；API key、用户数据库、构建产物与本地测试材料由 `.gitignore` 排除。
