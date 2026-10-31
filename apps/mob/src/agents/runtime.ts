// The port every coding agent is driven through, whatever protocol it speaks.
// Its shapes follow the Agent Client Protocol's, as ACP v2 has them: calls are
// updated by their ID, permission requests carry their own title, and a
// prompt's end says what it used. ACP is the default driver (acp.ts); an agent
// whose own protocol does more than its ACP adapter gets a driver of its own
// behind the same port.
import type { llm, Task } from '@mob/core';
import type { Conn } from './process';
import type { Preset } from './presets';

/** ToolKind is what a call does, as ACP names it. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** ToolContent is a part of what a call shows: text, or a file it changed. */
export type ToolContent = { type: 'text'; text: string } | { type: 'diff'; path: string; newText: string; oldText?: string | null };

/**
 * ToolUpdate starts a call, when start is set, or changes one the agent
 * started; what it leaves out stays as it was.
 */
export type ToolUpdate = {
	type: 'tool';
	start: boolean;
	id: string;
	title?: string | null;
	kind?: ToolKind | null;
	/** locations are the paths of the files the call works on. */
	locations?: string[] | null;
	input?: unknown;
	status?: ToolStatus | null;
	content?: ToolContent[] | null;
	output?: unknown;
};

/** Update is one thing an agent reports while it works. */
export type Update =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| ToolUpdate
	| { type: 'plan'; entries: { content: string; status: string }[] }
	/** context is how much of its context window the session fills, and what the agent's run cost so far. */
	| { type: 'context'; used: number; size: number; cost?: { amount: number; currency: string } | null }
	| { type: 'model'; model: string };

/** PermissionRequest is the agent asking before a call. */
export type PermissionRequest = {
	/** id is the call's. */
	id: string;
	/** title is what the agent asks about, such as the command or file; empty when the request names only the call. */
	title?: string | null;
	kind?: ToolKind | null;
	locations?: string[] | null;
	input?: unknown;
};

/** Choice answers a permission request: allow it once, keep allowing it, or not. */
export type Choice = 'allow' | 'always' | 'reject' | 'cancel';

/** StopReason is why a prompt ended, as ACP names it. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type ModelUsage = { model: string; usage: llm.Usage };

/** Ending is how a prompt ended: why, or what went wrong, and what the agent says it used. */
export type Ending = {
	reason?: StopReason;
	err?: unknown;
	/** signedOut is set when the agent ended the prompt asking to be signed in. */
	signedOut?: boolean;
	/** usage is what the prompt used, by model; empty when the agent does not say. */
	usage: ModelUsage[];
};

/** McpServer is an MCP server, reached over HTTP, that the agent's session gets. */
export type McpServer = { name: string; url: string; headers: Record<string, string> };

/** Handler takes what an agent sends while its session is open. */
export type Handler = {
	update(u: Update): void;
	/** permission is the owner's, or Mob's, answer to a request; cancel when there is none. */
	permission(r: PermissionRequest): Promise<Choice>;
};

/** Options open an agent's session for a task. */
export type Options = {
	preset: Preset;
	task: Task;
	/** conn is the started agent's standard input and output. */
	conn: Conn;
	/** servers are the MCP servers the session gets, given whether the agent takes them over HTTP. */
	servers(http: boolean): McpServer[];
	handler: Handler;
	/** created records the ID of a session the agent created, for the task to go on with later. */
	created(id: string): void;
};

/** AgentSession is a task's open session with its agent. */
export interface AgentSession {
	readonly id: string;
	/** model is the model the session started with. */
	readonly model: string;
	/** closed settles once the agent's connection ends. */
	readonly closed: Promise<void>;
	/** prompt sends text and settles when the agent ends its answer; it never fails, but says why in the ending. */
	prompt(text: string): Promise<Ending>;
	/** cancel asks the agent to end the prompt it is answering. */
	cancel(): void;
	/** close ends the agent. */
	close(): void;
	/** stderr is the end of what the agent wrote to standard error. */
	stderr(): string;
}

/** Runtime opens sessions with agents that speak one protocol. */
export interface Runtime {
	/** open starts a session: the task's own, again, or a new one in its worktree. It throws, with the agent's preset title, why it could not. */
	open(o: Options, signal: AbortSignal): Promise<AgentSession>;
}

// ansi matches terminal colour codes, which agents write to standard error.
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;

/** message is what err says, including the data of a JSON-RPC error. */
export function message(err: unknown) {
	if (err instanceof Error) return err.message;
	const e = err as { message?: string; data?: unknown } | undefined;
	if (e?.message) return e.data ? `${e.message}: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}` : e.message;
	return String(err);
}

/** failed explains why the agent failed to do what, with the end of what it wrote to standard error. */
export function failed(title: string, what: string, err: unknown, stderr: string) {
	let out = stderr.replace(ansi, '');
	if (out.length > 1000) out = out.slice(-1000);
	return new Error(`${title} failed to ${what}: ${message(err)}` + (out ? '\n' + out : ''));
}

/** signIn says the agent is not signed in and how to sign it in. */
export const signIn = (p: Preset) => new Error(`${p.title} is not signed in: ${p.signIn}`);
