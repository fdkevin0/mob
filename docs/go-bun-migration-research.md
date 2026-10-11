# Mob：Go + Bun、GUI / TUI 迁移选型

调研日期：2026-10-05。状态：用户已选择 AI Elements + AI SDK UI、Wails、SQLite + database/sql + 驱动、Bubble Tea + Bubbles + Lip Gloss，已完成首版本地会话闭环（运行方式和未迁移功能见 [README](../README.md)）。Bun 按 JavaScript 工具链理解，不是同名 Go ORM。桌面 GUI + TUI 已确定，独立 Web 部署、目标操作系统、是否保留 Telegram 和是否离线运行尚未确定。成熟度判断基于官方文档与当前仓库适配成本，不是性能实测。

采用组合：**Go + SQLite / database/sql / 驱动；Bun + 现有 React / Vite / Tailwind；AI Elements + AI SDK UI；Wails；Bubble Tea + Bubbles + Lip Gloss。** HTTP 默认采用 net/http，SQLite 驱动候选 modernc.org/sqlite，Wails 默认按 v2 稳定线规划；这些具体实现选择尚待集成验证。不同时引入 Go 和 Bun 两套长期运行的业务服务。

## 当前代码意味着什么

- [README](../README.md) 明确这是 reference code，缺 Telegram plumbing、Principal 和部分数据库/业务模块；不能把它当作可直接替换运行时的完整 app。
- [App.tsx](../webapp/src/miniapp/App.tsx) 是设置、记忆、邮件和书签页面，没有聊天界面。React 组件、样式和测试可复用；Telegram BackButton、主题、initData 鉴权必须解耦。
- [agentic.ts](../src/features/ai/agentic.ts) 使用 AI SDK 的多步流、MCP、usage 和 trace；[model.ts](../src/features/ai/model.ts) 还包含 DeepSeek 参数转换。迁移到 Go 要验证行为等价，不能仅替换 HTTP 请求。
- [ConversationAgent](../src/features/agent/conversation-agent.ts) 承担持久化队列、Session、调度、fibers 与恢复；[ADR-47](adr/0047-deepen-the-conversation-agent.md) 已分出 turn driver 和 stores，值得延续这些边界。
- [TurnEvent](../src/features/agent/turn-events.ts) 已覆盖 text/reasoning delta、工具开始/完成/失败与分段，适合作为跨 UI 的起点；它还不是完整可恢复的网络协议，缺少统一的 turn/message ID、序号、明确的终态和审批事件。
- [ADR-39](adr/0039-tool-approval-as-turn-boundary.md) 规定审批释放当前回合，批准后重新入队；不能让浏览器中的暂停状态成为审批唯一来源。
- [ADR-40](adr/0040-deep-task-runfiber-in-do.md) 只承诺中断后的部分结果恢复，不是逐步 durable replay。Go 版本应保留这一语义，避免为迁移顺手引入工作流平台。

## 分层选型

| 层 | 推荐 | 原因与边界 |
| --- | --- | --- |
| HTTP | `net/http`，复杂路由再加 chi | 标准库已有方法与路径参数路由；chi 保持标准 handler / middleware 兼容。无需预先引入完整 Web 框架。 |
| 数据 | `database/sql` + SQLite driver | 单机起步，延续现有 SQLite 表的思路；标准库不自带 SQLite driver。候选 modernc.org/sqlite 可避免数据库驱动的 CGO 要求，Wails 的平台构建依赖仍然存在。 |
| 前端 | 保留 React + Vite + Tailwind，Bun 安装和运行脚本 | Bun 官方支持 Vite。切包管理器与升级 React/测试框架应分开；保留 Vitest，先验证现有 build/test 再更换锁文件。 |
| 对话 | AI Elements + AI SDK UI，已选定 | Elements 提供显示组件，AI SDK UI 管理客户端消息流；Go 实现匹配固定 SDK 版本的 UI Message Stream。历史与审批由 Go 持久化。 |
| 普通 UI | 复用 `miniapp/ui.tsx`；缺复杂组件时按需引入 shadcn/ui | 不为聊天页重写已存在的设置组件；shadcn 是纳入项目维护的组件代码。 |
| 数据查询 | 先复用 requestJson / useAsyncResource | 多页面共享会话列表、缓存失效和重试出现实际复杂度后，再用 TanStack Query；它不应持有另一份独立聊天流状态。 |
| TUI | Bubble Tea + Bubbles + Lip Gloss；Markdown 用 Glamour | Go 生态内完成输入、滚动、布局与 Markdown 渲染。TUI 与 GUI 共用业务协议，不共用视觉组件。 |
| 桌面 | Wails v2 稳定线；v3 Beta 单独评估 | React 可复用，Go 方法有 TS bindings；系统 WebView 不意味着所有控件都有原生外观。多窗口/托盘/server builds 明确需要时才考虑 v3。 |

官方依据：[Go 路由](https://go.dev/doc/go1.22)、[chi](https://github.com/go-chi/chi)、[database/sql](https://pkg.go.dev/database/sql)、[SQLite driver](https://pkg.go.dev/modernc.org/sqlite)、[Bun + Vite](https://bun.com/guides/ecosystem/vite)、[shadcn/ui](https://ui.shadcn.com/docs)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)、[Bubble Tea](https://github.com/charmbracelet/bubbletea)、[Bubbles](https://github.com/charmbracelet/bubbles)、[Glamour](https://github.com/charmbracelet/glamour)、[Wails v2](https://wails.io/docs/introduction)、[Wails v3 Beta 公告](https://v3.wails.io/blog/wails-v3-beta/)。

### GUI / TUI 备选的取舍

| 方案 | 能解决什么 | 本项目取舍 |
| --- | --- | --- |
| 浏览器 GUI + Go 静态资源服务 | 最少打包工作，便于远程访问；Go embed 可携带构建资产 | 可用于前端开发和集成验证；独立 Web 部署暂未确定，桌面共用同一 React UI |
| Wails | Go + Web UI 的桌面壳、窗口、菜单、系统对话框 | 桌面首选；v2 是稳定线，v3 官方仍标 Beta，不将 Beta 写成 GA |
| Tauri 2 | Web UI + Rust 壳，可打包 Go sidecar | 能做，但增加 Rust 工具链、sidecar 生命周期与跨进程通信；只有明确依赖其平台能力才选 |
| Electron | Chromium + Node 的成熟桌面运行环境 | 浏览器一致性优先时可选；Go 已确定时增加进程与运行时成本，Bun 不替代 Electron 内置 Node |
| Fyne | 直接用 Go 编写跨平台 GUI | 若不要 Web UI 很合理；当前需复用 React 和成熟聊天库，重写 UI 成本更高 |
| tview | Go 终端表单、树、表格等现成组件 | 管理控制台优先可选；本项目以流式对话为主，推荐 Bubble Tea 的消息更新模型 |

这些是基于项目需求的判断，不是框架性能排名。参考：[embed](https://pkg.go.dev/embed)、[Tauri sidecar](https://v2.tauri.app/develop/sidecar/)、[Electron](https://github.com/electron/electron)、[Fyne](https://docs.fyne.io/)、[tview](https://github.com/rivo/tview)。桌面评估要实测中文输入法、键盘焦点、复制/选择、长对话滚动、文件选择与目标 OS 打包，不能拿官网体积数字作为本项目性能承诺。

### Go Web / Agent 框架

Gin / Echo 都可承载业务 API，团队已有经验可以采用，但本仓库没有这类既有投资；此阶段 net/http 已满足需求。[Gin 文档](https://gin-gonic.com/en/docs/)、[Echo 文档](https://echo.labstack.com/docs/)。

Fiber 当前提供 net/http 适配能力，不能沿用“完全不兼容”的旧判断；但它仍有自己的上下文与适配层，没有证据表明 Mob 的瓶颈是路由吞吐，暂不选。[Fiber adaptor](https://docs.gofiber.io/middleware/adaptor/)。

AI 层建议先迁移现有单 agent 的有限步数 tool loop，采用维护中的模型 SDK/provider adapter；不要在本次选型阶段锁定尚未验证 DeepSeek 扩展字段的客户端。若手工处理工具编排、事件和恢复的成本明显上升，重点评估 **Eino ADK**：官方已有 Go agent 抽象及 DeepSeek 集成。它不是现有 AI SDK 的无损替换，尤其需测 reasoning、工具参数流、usage 和取消行为。[Eino](https://www.cloudwego.io/docs/eino/overview/)、[DeepSeek adapter](https://github.com/cloudwego/eino-ext/tree/main/components/model/deepseek)。MCP 优先官方 [Go SDK](https://go.sdk.modelcontextprotocol.io/)。

## 共用服务的最小形态

Web 和 TUI 都调用同一个 Go HTTP API：JSON 处理发送、停止、审批与历史；SSE 推送回合事件。桌面使用同一 React 页面，原生功能才接 Wails bindings。这样无需为 GUI/TUI 分别维护 agent、审批和数据库状态机。若最终仅做离线桌面，可改成进程内 Go 调用与 Wails events，无需保留远程 API 的全部工作。

建议的命令形态是 `mob serve` 和 `mob tui`，桌面独立入口；这只是设计建议，本次不创建脚手架。Web/TUI 同时连接时由服务端唯一管理同一会话的执行顺序与数据库写入。Go 核心不要依赖 Wails 或 Bubble Tea。

消息结构至少保留 text、reasoning（模型实际返回的内容）、tool call/result、attachment、approval 和 status。UI 文本 transcript 可以继续作为显示/摘要产物，但不能作为唯一历史记录，否则重新打开页面后无法恢复工具卡片和审批状态。已被旧 transcript 丢弃的信息不能凭空迁回。

当前 TurnEvent 需补上稳定 ID、单调序号、回合结束/取消/错误和审批状态。事件增量与最终 segment 应更新同一个 message part，不能各追加一次导致重复文本。先做持久化消息快照 + 活跃回合状态恢复；若要求断线期间每个事件无损重放，再增加有界事件持久化，不预先做完整 event sourcing。

SSE 是传输格式，不代表自动兼容 AI SDK 的 UI stream protocol。已选择 AI SDK UI，默认由 Go 编码其规定的 UI Message Stream，客户端使用匹配版本的 transport；Wails 原生 bindings 仅用于桌面能力。TUI 将服务端事件映射为 Bubble Tea 消息，不另建一套业务状态。仅输出 token 文本不能覆盖工具、推理、附件和审批。详见 [对话 UI 专项](chat-ui-research.md)。

安全边界必须保留：服务端验证会话访问和审批权限；批准绑定已保存的参数快照并幂等执行；停止需要传播到模型和工具。桌面 localhost API 也应校验 token/Origin，不能因绑定 loopback 就默认可信。密钥保留在 Go 服务端。

## 真正需要迁移的运行时能力

| 原有能力 | Go 迁移要求 |
| --- | --- |
| DO queue / Sessions | SQLite 会话与待执行记录、会话级顺序执行；重启后识别中断回合 |
| alarms / cron | 保存调度记录和下次执行时间；启动时恢复；内存 timer 不是持久化调度 |
| fibers / deep task | context 取消、持久化任务状态与部分结果；遵守当前中断报告语义 |
| Vectorize + Workers AI embeddings | 若保留云服务，需验证可用外部 API 与凭证；若脱离 Cloudflare，另选 embedding / 向量存储并迁移索引；不能用全文搜索声称语义召回等价 |
| Cloudflare Sandbox | 保留远程隔离执行或评估替代沙箱；不能直接改成宿主机 exec 并称功能等价 |
| Telegram initData / Principal | 定义独立身份与会话所有权；Telegram 可成为可选入口 |
| 外部邮件、资产、书签模块 | 当前仓库缺完整实现，先确认是否迁移并取得源代码/数据契约，不能据此估算完整重写工期 |

依据来自仓库 [README](../README.md)、[ConversationAgent](../src/features/agent/conversation-agent.ts)、[sandbox ADR](adr/0019-sandbox-code-interpreter-tool.md)、[memory ADR](adr/0038-layered-memory-auto-recall-and-fact-extraction.md)。这里描述迁移责任，不承诺外部服务已验证可用。

## 建议实施顺序与验收

1. 已确定桌面 GUI + TUI 的技术栈；实施前明确首发 OS、本地还是远程服务、独立 Web 部署、Telegram 是否保留，以及记忆/沙箱/邮件必须保留哪些。
2. 验证 Go 模型适配器：正常流、推理字段、一次工具调用、工具错误、取消、usage。对照当前 fixtures / tests 检查行为。
3. 完成一条 Go + React 对话闭环：发送 → 流式文字/工具卡 → 审批 → 续跑 → 历史恢复。可先用假模型/工具，不必迁完所有服务。
4. Bubble Tea 连接相同 API。验收两个 UI 看到一致历史，重复审批不重复执行，断线重连不重复消息，取消与进程重启能得到明确终态。
5. 加入 Wails 打包与 OS 实测；再逐项迁移记忆、调度、沙箱和邮件。导入数据先做副本演练与回滚校验。

退出条件：如果 Go 模型适配器仍需大量补齐 provider 语义，可暂保留 TS AI 内核作为过渡服务，但需明确删除条件。这是降低迁移风险的备选，不是默认的 Go + Bun 双后端设计。

调研阶段未做性能实测。后续实施已完成 Go / SQLite、AI Elements + AI SDK UI、Wails 和 Bubble Tea 的本地首版，验证了 macOS arm64 打包与窗口连接、Go 竞态测试、前端测试、真实 AI SDK UI 解析器对 Go 流的消费及重启恢复。未使用真实模型密钥验证付费推理，未验证其他操作系统；具体功能边界以 [README](../README.md) 为准。
