// Tools the model may call, how a call asks for approval, and the tools every conversation offers.
import type { Tool as LLMTool, ToolCall as LLMToolCall } from '../llm/llm';
import type { Event } from './events';
import { historyName } from './history';
import { searchName, type Entry, type Exposure } from './search';
import type { Message, Part, Store } from './store';

/** SandboxResult is what a command run in the sandbox returned. */
export type SandboxResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean };

/** Sandbox runs commands where they cannot reach the host. With one configured, the model may run anything there without asking. */
export interface Sandbox {
	exec(conversationID: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult>;
	/** offline is set for a sandbox whose commands have no network. */
	offline?(): boolean;
}

export const sandboxDefaultTimeout = 2 * 60_000, sandboxMaxTimeout = 5 * 60_000;

/** Tool is one function the model may call: its definition, what it adds to the system prompt when offered, and how it runs. */
export type Tool = LLMTool & {
	prompt?: string;
	/** ownerOnly tools are offered, and their approved calls carried out, only for the person who owns this Mob. */
	ownerOnly?: boolean;
	/** exposure is how the tool reaches the model; direct when unset. */
	exposure?: Exposure;
	/** namespace groups deferred tools where tool_search is described, such as "MCP server github". */
	namespace?: string;
	/** available reports whether turns offer the tool now; unset offers it always. */
	available?: () => boolean;
	/** run's output goes back to the model; so does its error, unless it is AwaitingApproval or an Abort. */
	run: (call: ToolCall) => Promise<unknown>;
	/** approved carries out a call the user approved after run asked with requestApproval. */
	approved?: (call: ApprovedCall) => Promise<unknown>;
	/**
	 * revise checks what the owner changed input to as they approved it, and
	 * returns the input to carry out; a tool without it is approved only as
	 * it asked.
	 */
	revise?: (input: string, changed: unknown) => Promise<unknown>;
	/** scope names what remembering an approval of input covers; unset covers every call of the tool. */
	scope?: (input: string) => string;
};

/** ApprovedCall is a call the user approved. input is what run passed to requestApproval, as JSON. */
export type ApprovedCall = { conversationId: string; approvalId: string; input: string; store: Store; owner: boolean; signal?: AbortSignal };

/** AwaitingApproval ends the turn after a tool has requested approval; the call completes when the user decides. */
export class AwaitingApproval extends Error {
	constructor() { super('awaiting approval'); }
}

/** AbortTool makes a tool's error end the turn instead of going to the model. */
export class AbortTool extends Error {
	constructor(readonly cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); }
}

/** Granted is requestApproval's answer when a remembered approval covers the call; the engine then carries it out. */
export class Granted extends Error {
	constructor(readonly input: string) { super('approved by a remembered decision'); }
}

export const scopeOf = (t: Tool, input: string) => (t.scope ? t.scope(input) : '');

/** ToolCall is one invocation of a tool within a turn. */
export class ToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
	constructor(call: LLMToolCall, readonly conversationId: string, readonly input: Record<string, any>,
		/** part is the call as stored in message; a tool may change what it records. */
		readonly part: Part, readonly message: Message, readonly store: Store, readonly send: (e: Event) => Promise<void>,
		readonly signal: AbortSignal,
		/** tool is set for turns that may use remembered approvals: the owner's. */
		readonly tool?: Tool) {
		this.id = call.id; this.name = call.name; this.arguments = call.arguments;
	}

	/** requestApproval asks the user to approve input, which the call records as its input; it always throws. */
	async requestApproval(input: unknown): Promise<never> {
		this.part.input = input;
		try {
			if (this.tool?.approved) {
				const raw = JSON.stringify(input);
				if (this.store.granted(this.conversationId, this.name, scopeOf(this.tool, raw))) throw new Granted(raw);
			}
			const id = this.store.requestApproval(this.conversationId, this.message, this.id, input);
			await this.send({ kind: 'approval-requested', approvalId: id, toolCallId: this.id, toolName: this.name, input });
		} catch (e) {
			if (e instanceof Granted) throw e;
			throw new AbortTool(e);
		}
		throw new AwaitingApproval();
	}
}

/** sandboxName is reserved for the sandbox tool, which turns add while a sandbox is set. */
export const sandboxName = 'sandbox';
const reserved = (name: string) => name === sandboxName || name === searchName || name === historyName;

/** ToolRegistry holds the tools every turn offers. */
export class ToolRegistry {
	private tools: Tool[] = [];
	private sources: (() => Tool[])[] = [];
	private entrySources: (() => Entry[])[] = [];

	register(...tools: Tool[]) {
		for (const t of tools) {
			if (!t.name || !t.run) throw new Error('tool needs a name and run: ' + t.name);
			if (reserved(t.name)) throw new Error('tool name is reserved: ' + t.name);
			if (this.tools.some(o => o.name === t.name)) throw new Error('tool registered twice: ' + t.name);
			this.tools.push(t);
		}
	}

	/** registerSource adds tools that change while Mob runs; a tool listed under a name already taken is left out. */
	registerSource(source: () => Tool[]) { this.sources.push(source); }

	list(): Tool[] {
		const list = [...this.tools];
		for (const source of this.sources) {
			for (const t of source()) if (t.name && !reserved(t.name) && typeof t.run === 'function' && !list.some(o => o.name === t.name)) list.push(t);
		}
		return list;
	}

	/** registerEntries adds things tool_search finds besides tools, such as skills. */
	registerEntries(source: () => Entry[]) { this.entrySources.push(source); }
	entries(): Entry[] { return this.entrySources.flatMap(s => s()); }
}

/** rfc3339 is d in zone as Go's time.RFC3339 writes it. */
export function rfc3339(d: Date, zone: string) {
	const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(p => [p.type, p.value]));
	const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
	const offset = Math.round((local - Math.floor(d.getTime() / 1000) * 1000) / 60000);
	const stamp = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
	if (offset === 0) return stamp + 'Z';
	const sign = offset < 0 ? '-' : '+', abs = Math.abs(offset);
	return `${stamp}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const validZone = (zone: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } };

/** defaultTools are the tools every conversation offers. */
export function defaultTools(): Tool[] {
	return [
		{
			name: 'datetime', description: 'Get current date and time in an optional IANA timezone.',
			parameters: { type: 'object', properties: { timezone: { type: 'string' } }, additionalProperties: false },
			run: async call => {
				let zone = typeof call.input.timezone === 'string' && call.input.timezone ? call.input.timezone : 'Asia/Shanghai';
				if (!validZone(zone)) zone = 'UTC';
				const now = new Date();
				return { iso: rfc3339(now, 'UTC'), readable: rfc3339(now, zone), timezone: zone };
			},
		},
		{
			name: 'remember',
			description: 'Request permission to save one durable fact about the user locally. Facts the owner approves are recalled in all of their conversations. Stops the turn until the user approves.',
			parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'], additionalProperties: false },
			run: async call => {
				const fact = typeof call.input.fact === 'string' ? call.input.fact.trim() : '';
				if (!fact || new TextEncoder().encode(fact).length > 2000) throw new Error('fact must be 1–2000 bytes');
				return call.requestApproval({ fact });
			},
			approved: async call => {
				const { fact } = JSON.parse(call.input) as { fact: string };
				call.store.saveFact(call.approvalId, call.conversationId, fact, call.owner);
				return { saved: true };
			},
		},
	];
}

/** sandboxTool runs commands in box and describes it to the model, so it does not try the network where there is none. */
export function sandboxTool(box: Sandbox): Tool {
	const allowed = box.offline?.()
		? 'Anything is allowed there, but it has no network: packages cannot be downloaded, so use what the image provides. '
		: 'Anything is allowed there: install packages, run code, use the network. ';
	return {
		name: sandboxName,
		description: 'Run a shell command (sh -c) in an isolated Linux container. ' + allowed +
			"Only /workspace, the working directory, persists between calls in this conversation; the user's own files and machine are not reachable.",
		parameters: {
			type: 'object', properties: {
				command: { type: 'string' },
				timeout: { type: 'integer', minimum: 1, maximum: sandboxMaxTimeout / 1000, description: 'Seconds; default ' + sandboxDefaultTimeout / 1000 },
			}, required: ['command'], additionalProperties: false,
		},
		prompt: "Use the sandbox for isolated calculations, experiments and installed skill scripts; it needs no permission inside its container. It cannot access the user's host projects. When coding-agent tools are available, hand work on those projects to a coding agent.",
		run: call => box.exec(call.conversationId, String(call.input.command ?? ''), typeof call.input.timeout === 'number' ? Math.trunc(call.input.timeout) * 1000 : 0, call.signal),
	};
}
