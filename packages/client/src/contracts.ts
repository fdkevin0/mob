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
  /** deleted is set for a conversation that was deleted; its tokens stay counted. */
  deleted?: boolean;
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
/** ContextParts splits a prompt's tokens by what they are. */
export type ContextParts = {
  system: number;
  tools: number;
  summary: number;
  messages: number;
  outputs: number;
};
/**
 * ContextSnapshot is what a conversation's prompt takes of its model's context window
 * (GET /api/conversations/{id}/context, and the data-context part while a turn runs).
 * limit is the window less what is kept for the reply; history beyond it is summarized.
 * A window of zero is unknown.
 */
export type ContextSnapshot = {
  model: string;
  window: number;
  reserve: number;
  limit: number;
  used: number;
  /** measured is set once the provider counted the prompt; used is an estimate until then. */
  measured: boolean;
  parts?: ContextParts;
  tools?: number;
  /** summarized counts the earlier messages read as a summary; omitted is set when older ones are left out without one. */
  summarized?: number;
  omitted?: boolean;
  /** agent is set when an outside coding agent reported the numbers, without parts. */
  agent?: boolean;
};
export type ConversationContext = {
  context: ContextSnapshot | null;
  usage?: UsageSummary;
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
  flow?: Flow;
  createdAt: number;
  updatedAt: number;
};
export type FlowCheck = {
  command: string;
  passed: boolean;
  exitCode?: number;
  seconds: number;
};
export type FlowStage = {
  type: string;
  retries?: number;
  aspects?: string[];
  rounds?: number;
};
export type Flow = {
  blueprint: string;
  stages?: FlowStage[];
  stage: string;
  round: number;
  tries: number;
  checks?: FlowCheck[];
  review?: string;
  note?: string;
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

/** Transfer is a conversation moving between Mobs (GET /api/conversations/{id}/export, POST /api/conversations/import). */
export type Transfer = {
  v: 1;
  title: string;
  model: string;
  summary: string;
  summaryThrough: string;
  messages: { id: string; role: string; parts: string; status: string; error: string; model: string; usage: string; kind: string }[];
  facts: { fact: string; owner: boolean }[];
  usage: { messageId: string; session: string; model: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; durationMs: number; createdAt: number }[];
};

// Management views use structured data; slash command Markdown is only presentation.
export type Memory = { id: string; conversationId: string; text: string; owner: boolean };
export type RememberedApproval = { id: string; conversationId: string; tool: string; scope: string; created: number };
export type ScheduledPrompt = { id: string; conversationId: string; prompt: string; next: number; repeat?: string; zone?: string };
export type ProjectConfig = { name: string; path: string; blueprint?: string; checks?: string[] };
export type Projects = { projects: ProjectConfig[]; blueprints: { name: string; title: string; description: string }[] };

/** Web extension management; paths and credentials remain service-owned. */
export type SkillSource = { source: string; ref?: string; skillPath: string };
export type SkillPreview = SkillSource & { commit: string; name: string; description: string; content: string; files: string[]; executableFiles: string[]; folderHash: string };
export type SkillUpdate = { status: 'current' | 'available' | 'unknown' | 'error'; message: string };
export type InstalledSkill = { name: string; description: string; compatibility?: string; managed: boolean; source?: string; ref?: string; update?: SkillUpdate };
export type SkillsOverview = { skills: InstalledSkill[]; warnings: string[] };
export type MCPOverview = {
  servers: { name: string; managed: boolean; shadowed: boolean; connected: boolean; status: string; signInUrl?: string; tools: { name: string; description?: string; exposure: string }[] }[];
  catalog: { name: string; title?: string; description: string; url: string; source: string; repository?: string; version?: string; requiredHeader?: string }[];
};
