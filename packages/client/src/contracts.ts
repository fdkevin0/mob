// The wire contract between Mob and its clients: the host serves these shapes and every client reads them.
export type Endpoint = {
  host: string;
  port: number;
  security: string;
  username: string;
  password?: string;
  hasPassword?: boolean;
};
export type EmailChannel = {
  enabled: boolean;
  owner: string;
  verifier: string;
};
export type EmailConfig = {
  enabled: boolean;
  from: string;
  imap: Endpoint;
  smtp: Endpoint;
  channel: EmailChannel;
};
export type TelegramConfig = {
  enabled: boolean;
  token?: string;
  hasToken?: boolean;
  userId: number;
};
export type CloudflareConfig = {
  enabled: boolean;
  accountId: string;
  token?: string;
  hasToken?: boolean;
  model: string;
  embeddingModel: string;
  index: string;
  databaseId: string;
  namespaceId: string;
  bucket: string;
  accessKey?: string;
  secretKey?: string;
  hasSecretKey?: boolean;
};
export type WeChatILinkConfig = {
  enabled: boolean;
  baseUrl?: string;
  botToken?: string;
  hasToken?: boolean;
  botId?: string;
  allowedUsers?: string[];
};
export type Configs = {
  email: EmailConfig;
  telegram: TelegramConfig;
  cloudflare: CloudflareConfig;
  wechat_ilink: WeChatILinkConfig;
};
export type Config = {
  defaultModel: string;
  demo: boolean;
};
export type SecretUpdate = {
  mode: string;
  value?: string;
};
export type Delivery = {
  id: string;
  state: string;
  reply: string;
  error: string;
  updatedAt: number;
};
export type CommandSpec = {
  name: string;
  usage: string;
  summary: string;
  clients: string[];
  transcript?: boolean;
};
export type Suggestion = {
  value: string;
  label: string;
  detail?: string;
};
export type CommandRequest = {
  client: string;
  conversationId?: string;
  text: string;
};
export type Action = {
  kind: string;
  conversationId?: string;
  approvalId?: string;
  approved?: boolean;
  reason?: string;
  remember?: string;
};
export type CommandResult = {
  handled: boolean;
  markdown?: string;
  action?: Action;
};
export type ModelUsage = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
  requests: number;
};
export type DayUsage = {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
  requests: number;
};
export type TopConversation = {
  id: string;
  title: string;
  agent?: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
  requests: number;
  turns: number;
};
export type UsageReport = {
  since: number;
  firstDay: string;
  lastDay: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
  requests: number;
  turns: number;
  models: ModelUsage[];
  conversations: number;
  days: DayUsage[];
  top: TopConversation[];
};
export type UsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
  requests: number;
  turns: number;
  models: ModelUsage[];
};
export type PlanEntry = {
  content: string;
  status: string;
};
export type Task = {
  id: string;
  conversationId: string;
  project: string;
  agent: string;
  title: string;
  worktree: string;
  branch: string;
  session?: string;
  status: string;
  parent?: string;
  readOnly?: boolean;
  outcome?: string;
  result?: string;
  plan?: PlanEntry[];
  createdAt: number;
  updatedAt: number;
};
export type AgentApproval = {
  id: string;
  tool: string;
  text: string;
  whole: boolean;
};
export type AgentNode = {
  conversationId: string;
  parent?: string;
  agent: string;
  label: string;
  model?: string;
  title: string;
  status: string;
  approvals: AgentApproval[];
  tools: string[];
  task?: Task;
  usage?: UsageSummary;
};
