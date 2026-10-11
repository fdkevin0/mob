# Go 后端的 React 对话 UI 选型

调研日期：2026-10-05。依据官方文档与源码；未运行集成原型。以下排序是针对“Go 负责应用逻辑，Bun 负责前端工具链”的工程判断，不是通用市场排名。

**用户已选定 AI Elements + AI SDK UI，配合 Wails、Go、SQLite 与 Bubble Tea。** 下方保留调研比较，assistant-ui 为未采用备选。Go 直接提供聊天流，不需要为了聊天另起 Bun/Node 业务后端。

| 候选 | 实际提供什么 | 接 Go 的方法 | 适用判断 |
| --- | --- | --- | --- |
| assistant-ui | 聊天组件、消息与线程状态、编辑/重生成/取消、工具 UI | `LocalRuntime` 的 `ChatModelAdapter`；已有消息状态则用 `ExternalStoreRuntime` | 完整聊天体验备选，本次不采用 |
| AI Elements + AI SDK UI | Elements 提供可复制组件；SDK UI 提供 hooks、transport 与消息流处理 | Go 实现 UI Message Stream SSE，或自定义 transport | 已选定；自行组合布局及会话管理 |
| Ant Design X + X SDK | Ant 风格聊天组件与可自定义 provider 的数据层 | `XRequest` / `XStream` + 自定义 provider | 已采用 Ant Design 时成本最低 |
| CopilotKit | 聊天、前端工具、共享状态、人工确认、agent 集成 | 接已有 agent；默认方案通过 CopilotRuntime | 对“给现有 app 加会话”偏重，对“agent 操作 app”更有价值 |

## assistant-ui：完整聊天优先

官方提供流式输出、自动滚动、附件、Markdown、代码高亮、键盘操作与无障碍基础，核心库 MIT，Assistant Cloud 是可选服务。[项目说明](https://github.com/assistant-ui/assistant-ui)

自定义 `LocalRuntime` 只需实现 `run`，运行时处理聊天状态、分支和取消；流式 `async *run` 每次必须 yield **累计内容**。Go 的 SSE、WebSocket 或桌面事件可在这一层转换，因此不绑定 AI SDK。需要 reasoning 和工具审批时也有相应消息结构及 gate；审批后真正执行工具仍是后端职责。部分人工交互 API 标注 `unstable`，升级需核对。[LocalRuntime 文档](https://www.assistant-ui.com/docs/runtimes/custom/local-runtime)

附件与历史由 adapter 接入自有存储；`history.update` 对审批暂停后继续写入结果很重要，只有 append 不能完整覆盖这类生命周期。[Adapter 支持矩阵](https://www.assistant-ui.com/docs/runtimes/concepts/adapters) 默认附件转换会在内存产生 base64，大文件应上传服务器后传 URL。[附件文档](https://www.assistant-ui.com/docs/guides/attachments)

**代价：** 必须理解 runtime 的消息模型，自己适配现有会话和后端事件；“内置历史 UI”不代表已经有持久化数据库。

## AI Elements + AI SDK UI：组件与传输分开

AI Elements 是 shadcn/ui 方式的源码组件，安装后由项目自己维护；当前文档以 React 19、Tailwind CSS 4 为目标，入门示例偏向 Next.js。对 Vite/Bun 项目应选装组件并验证依赖，不应把整套 Next.js 示例当作迁移前提。[介绍](https://elements.ai-sdk.dev/docs) Elements 的许可证是 **Apache-2.0**。[LICENSE](https://raw.githubusercontent.com/vercel/ai-elements/main/LICENSE)

Go 可以直接提供 AI SDK UI 的 SSE 协议：响应头 `x-vercel-ai-ui-message-stream: v1`，事件包含 text、reasoning、file、tool input/output、approval、error、finish。普通文本流只适合纯文字，不承载完整工具调用。无需在 Go 与浏览器间增加 JS 代理。[官方协议](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)

Elements 已有附件、Reasoning、Tool、Sources 等组件；`Confirmation` 展示审批请求和结果，配合 `addToolApprovalResponse`。[组件目录](https://elements.ai-sdk.dev/) [Confirmation](https://elements.ai-sdk.dev/components/confirmation)

**代价：** 组件不是完整产品，会话列表、存储、权限与 Go 侧审批恢复仍要实现；Go 必须严格跟随选定 SDK 版本的协议。当前官方不同页面的示例 API 存在代际差异，实施时固定版本，避免从不同文档拼接调用。

## Ant Design X：适合管理界面

`useXChat` 支持自定义 provider、取消、重生成、消息修改以及异步加载历史，消息格式可自行定义。[useXChat](https://x.ant.design/x-sdks/use-x-chat/) `XStream` 默认解码 SSE，也允许自定义 TransformStream，适合 Go 自定义接口。[XStream](https://x.ant.design/x-sdks/x-stream/)

**判断：** 若应用以表格、表单、任务详情为主且已用 Ant Design，X 能保持统一体验；工具审批、持久化和跨端事件语义应由应用定义，不应把 Thinking/流程展示等视觉组件当作后端工作流引擎。`@ant-design/x` 与 X SDK 均为 MIT。[X 包声明](https://github.com/ant-design/x/blob/main/packages/x/package.json) [X SDK LICENSE](https://github.com/ant-design/x/blob/main/packages/x-sdk/LICENSE)

## CopilotKit：能力多，但默认架构更重

官方定位涵盖 chat、交互 UI、共享状态与人工审批；强调接入现有 agent。[产品文档](https://docs.copilotkit.ai/) 当前 quickstart 需要 `@copilotkit/runtime`，客户端 SPA 的默认接法也要求单独 runtime 服务；因此不能按“装几个 React 组件就直接接 Go”估算工作量。[Quickstart](https://docs.copilotkit.ai/quickstart)

**判断：** 当需求是 agent 读取/更新页面状态、调用前端功能、执行多步骤交互时才优先它。此次未核验 Go 直连在所需全部功能下的闭环，不将其列为零适配方案。附件、reasoning、持久化的具体能力须按选定 backend 与部署方式验证，不能由首页能力声明推断所有组合都支持。

核心仓库声明 MIT，但 `showcase` 有独立的 source-available 许可，不能将演示代码一概按 MIT 搬入产品。[核心仓库](https://github.com/CopilotKit/CopilotKit) [Showcase 许可](https://github.com/CopilotKit/CopilotKit/blob/main/showcase/LICENSE)

## 最小验证范围

使用 AI Elements + AI SDK UI 接一个 Go 会话，固定前端 SDK 与服务端流协议版本，跑通：中文流式文本、工具请求→批准/拒绝→继续、停止生成、切换会话后恢复、刷新加载历史、附件上传。Wails 验证相同界面的流式连接和中文输入法；Bubble Tea 验证共享会话、审批和取消的结果一致。审批保留现有“结束回合、批准后重新入队”语义，不直接照搬前端自动续跑示例。

GUI 和 TUI 应共享 Go 的会话、工具和审批状态；不共享 React 组件。前端只能提交审批决定，Go 核验对应 run/tool/approval 是否仍有效，再执行动作。Bun 初期仅用于安装、开发和构建前端；除非确有 TS 服务端能力要求，不新增第二个常驻后端。
