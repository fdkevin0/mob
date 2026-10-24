// The coding agents Mob knows how to start, over the Agent Client Protocol.
import type { llm } from '@mob/core';
import { codexTally } from './usage';

export type Preset = {
	name: string;
	title: string;
	/** commands start the agent's ACP server; the first whose program is installed is used. */
	commands: string[][];
	/** mode is the session mode that lets the agent edit its working directory and run commands there without asking. */
	mode?: string;
	/**
	 * readOnly is the session mode in which the agent asks before editing
	 * anything, for tasks that only read another task's worktree; Mob then
	 * refuses its edits. Agents without one cannot do such tasks.
	 */
	readOnly?: string;
	/** signIn tells the owner how to sign the agent in. */
	signIn: string;
	/**
	 * tally, for agents whose prompt responses do not say what they used,
	 * reads what the agent recorded its session used so far, and the model it
	 * last used.
	 */
	tally?: (session: string) => Promise<{ model: string; usage: llm.Usage }>;
	/** env is added to the agent's environment. */
	env?: Record<string, string>;
	/** patch, when set, is a DeepSeek Harness configuration layer the agent is started with. */
	patch?: string;
};

/** presets are the agents tasks can use; the first is the default. */
export const presets: Preset[] = [{
	name: 'codex',
	title: 'Codex',
	commands: [['codex-acp'], ['npx', '-y', '@zed-industries/codex-acp@0.16.0']],
	mode: 'auto',
	readOnly: 'read-only',
	signIn: 'run `codex login` on the computer Mob runs on (`codex login --device-auth` without a browser there), or set OPENAI_API_KEY or CODEX_API_KEY for the Mob service',
	tally: codexTally,
}, {
	name: 'claude',
	title: 'Claude Agent',
	commands: [['claude-agent-acp'], ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.94.0']],
	mode: 'acceptEdits',
	readOnly: 'default',
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
	mode: 'acceptEdits',
	readOnly: 'default',
	signIn: 'run `codebuddy` on the computer Mob runs on and log in with the Tencent account you use for WorkBuddy or CodeBuddy (WeChat for the China edition), or set CODEBUDDY_API_KEY for the Mob service, with CODEBUDDY_INTERNET_ENVIRONMENT=internal for the China edition',
}];

/** preset finds an agent by name; empty is the default. */
export function preset(name: string): Preset {
	if (!name) return presets[0]!;
	const p = presets.find(p => p.name === name);
	if (!p) throw new Error(`unknown coding agent ${JSON.stringify(name)}; available: ${presets.map(p => p.name).join(', ')}`);
	return p;
}

/** readers names the agents that can work read-only. */
export const readers = () => presets.filter(p => p.readOnly).map(p => p.name);

/** command is the first of p's commands whose program is installed. */
export const command = (p: Preset) => p.commands.find(c => Bun.which(c[0]!));
