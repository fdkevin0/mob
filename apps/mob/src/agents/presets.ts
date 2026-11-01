// The coding agents Mob knows how to start. Each speaks the Agent Client
// Protocol unless its preset names another runtime.
import { acp } from './acp';
import { codex } from './codex';
import type { Runtime } from './runtime';

export type Preset = {
	name: string;
	title: string;
	/** runtime drives the agent; unset is the Agent Client Protocol's. */
	runtime?: Runtime;
	/** commands start the agent's server, for its runtime to talk to; the first whose program is installed is used. */
	commands: string[][];
	/**
	 * acp holds the session modes an ACP agent works in: mode lets it edit its
	 * working directory and run commands there without asking; readOnly makes
	 * it ask before editing anything, for tasks that only read another task's
	 * worktree, whose edits Mob then refuses.
	 */
	acp?: { mode?: string; readOnly?: string };
	/** signIn tells the owner how to sign the agent in. */
	signIn: string;
	/** env is added to the agent's environment. */
	env?: Record<string, string>;
	/** patch, when set, is a DeepSeek Harness configuration layer the agent is started with. */
	patch?: string;
};

/** presets are the agents tasks can use; the first is the default. */
export const presets: Preset[] = [{
	name: 'codex',
	title: 'Codex',
	// Codex's own app server, rather than its ACP adapter.
	runtime: codex,
	commands: [['codex', 'app-server'], ['npx', '-y', '@openai/codex@0.166.0', 'app-server']],
	signIn: 'run `codex login` on the computer Mob runs on (`codex login --device-auth` without a browser there), or set OPENAI_API_KEY or CODEX_API_KEY for the Mob service',
}, {
	name: 'claude',
	title: 'Claude Agent',
	commands: [['claude-agent-acp'], ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.94.0']],
	acp: { mode: 'acceptEdits', readOnly: 'default' },
	signIn: 'run `claude` and sign in with your Claude subscription (/login) on the computer Mob runs on, or set ANTHROPIC_API_KEY for the Mob service',
}, {
	name: 'dsh',
	title: 'DeepSeek Harness',
	// Only through npx: other programs are also called dsh.
	commands: [['npx', '-y', '@deepseek-ai/dsh@0.2.1-rc.2', '--profile', 'acp']],
	signIn: 'save a DeepSeek API key in DeepSeek Harness (`npx @deepseek-ai/dsh web`, Models), or set DEEPSEEK_API_KEY for the Mob service',
	// What the agent does stays on this computer: no session log upload to
	// DeepSeek and no telemetry.
	env: { DSH_TELEMETRY_MODE: 'DISABLED' },
	patch: '- id: session-log-deepseek\n  disabled: true\n',
}, {
	name: 'codebuddy',
	title: 'CodeBuddy Code',
	commands: [['codebuddy', '--acp'], ['npx', '-y', '@tencent-ai/codebuddy-code@2.171.0', '--acp']],
	acp: { mode: 'acceptEdits', readOnly: 'default' },
	signIn: 'run `codebuddy` on the computer Mob runs on and log in with the Tencent account you use for WorkBuddy or CodeBuddy (WeChat for the China edition), or set CODEBUDDY_API_KEY for the Mob service, with CODEBUDDY_INTERNET_ENVIRONMENT=internal for the China edition',
}];

/** preset finds an agent by name; empty is the default. */
export function preset(name: string): Preset {
	if (!name) return presets[0]!;
	const p = presets.find(p => p.name === name);
	if (!p) throw new Error(`unknown coding agent ${JSON.stringify(name)}; available: ${presets.map(p => p.name).join(', ')}`);
	return p;
}

/** runtime is what drives p's agent. */
export const runtime = (p: Preset) => p.runtime ?? acp;

/** reads reports whether p's agent can work read-only. */
export const reads = (p: Preset) => runtime(p).reads(p);

/** readers names the agents that can work read-only. */
export const readers = () => presets.filter(reads).map(p => p.name);

/** command is the first of p's commands whose program is installed. */
export const command = (p: Preset) => p.commands.find(c => Bun.which(c[0]!));
