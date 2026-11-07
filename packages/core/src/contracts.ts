// Shared wire and plugin contracts between @mob/core, @mob/client and host plugins.
export * from './app/plugin-config';
export { jsonSchema } from './chat/tools';
export type { SecretUpdate } from './app/configuration';
export type { AgentApproval, AgentNode } from './app/server';
export type { CommandSpec, Suggestion, CommandRequest, Action, CommandResult } from './chat/commands';
export type {
	Fact,
	Grant,
	Schedule,
	Delivery,
	PlanEntry,
	Task,
	FlowCheck,
	FlowStage,
	Flow,
	Transfer,
	ModelUsageRow as ModelUsage,
	DayUsage,
	TopConversation,
	UsageReport,
	UsageSummary,
} from './chat/store';
export type { ContextParts, ContextSnapshot } from './chat/engine';

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
