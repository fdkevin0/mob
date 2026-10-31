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

// The service's own types are the contract: they are imported from @mob/core, never copied,
// so a field the core adds or changes reaches every client's type checks.
import type { ContextSnapshot, Fact, Grant, Schedule, UsageSummary } from '@mob/core';

export type {
  SecretUpdate,
  Delivery,
  CommandSpec,
  Suggestion,
  CommandRequest,
  Action,
  CommandResult,
  ModelUsageRow as ModelUsage,
  DayUsage,
  TopConversation,
  UsageReport,
  UsageSummary,
  ContextParts,
  ContextSnapshot,
  PlanEntry,
  Task,
  FlowCheck,
  FlowStage,
  Flow,
  AgentApproval,
  AgentNode,
  Transfer,
} from '@mob/core';

export type ConversationContext = { context: ContextSnapshot | null; usage?: UsageSummary };

// Management views use structured data; slash command Markdown is only presentation.
export type Memory = Fact;
export type RememberedApproval = Grant;
export type ScheduledPrompt = Schedule;
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
