// Tools the model may call, how a call asks for approval, and the tools every conversation offers.
import { z } from 'zod';
import type { Tool as LLMTool, ToolCall as LLMToolCall } from '../llm/llm';
import type { Event } from './events';
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
	/** input, when set, checks the model's arguments before run sees them; tools defined with defineTool set it. */
	input?: z.ZodType<Record<string, unknown>>;
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

/** jsonSchema is a zod schema as the JSON Schema a model reads, without the $schema line every provider ignores
 * or the safe-integer bounds zod writes for every .int(), which only cost the model tokens. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	const { $schema: _, ...rest } = z.toJSONSchema(schema, {
		override: ({ jsonSchema: s }) => {
			if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
			if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
		},
	}) as Record<string, unknown>;
	return rest;
}

/** ToolInput is a tool's arguments as its schema describes them. */
export type ToolInput<S extends z.ZodObject> = z.output<S>;

/** TypedCall is a call whose input is only the fields the tool declared. */
export type TypedCall<S extends z.ZodObject> = Omit<ToolCall, 'input'> & { input: ToolInput<S> };

/**
 * defineTool declares a tool by a zod schema of its arguments: the model is
 * offered the schema as JSON Schema, and the engine checks the model's
 * arguments against it before run, which receives them parsed.
 */
export function defineTool<S extends z.ZodObject>(t: Omit<Tool, 'parameters' | 'input' | 'run'> & { input: S; run: (call: TypedCall<S>) => Promise<unknown> }): Tool {
	return { ...t, parameters: jsonSchema(t.input), input: t.input as unknown as z.ZodType<Record<string, unknown>>, run: t.run as Tool['run'] };
}

/** checkInput is a call's arguments as the tool's schema parses them, or the error the model gets back. */
export function checkInput(tool: Tool | undefined, input: Record<string, any>): { input: Record<string, any> } | { error: Error } {
	if (!tool?.input) return { input };
	const r = tool.input.safeParse(input);
	return r.success ? { input: r.data } : { error: new Error('invalid tool arguments:\n' + z.prettifyError(r.error)) };
}

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
const reserved = (name: string) => name === sandboxName || name === searchName;

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
		defineTool({
			name: 'datetime', description: 'Get current date and time in an optional IANA timezone.',
			input: z.object({ timezone: z.string().optional() }),
			run: async call => {
				let zone = call.input.timezone || 'Asia/Shanghai';
				if (!validZone(zone)) zone = 'UTC';
				const now = new Date();
				return { iso: rfc3339(now, 'UTC'), readable: rfc3339(now, zone), timezone: zone };
			},
		}),
		defineTool({
			name: 'remember',
			description: 'Request permission to save one durable fact about the user locally. Facts the owner approves are recalled in all of their conversations. Stops the turn until the user approves.',
			input: z.object({ fact: z.string() }),
			run: async call => {
				const fact = call.input.fact.trim();
				if (!fact || new TextEncoder().encode(fact).length > 2000) throw new Error('fact must be 1–2000 bytes');
				return call.requestApproval({ fact });
			},
			approved: async call => {
				const { fact } = JSON.parse(call.input) as { fact: string };
				call.store.saveFact(call.approvalId, call.conversationId, fact, call.owner);
				return { saved: true };
			},
		}),
	];
}

/** sandboxTool runs commands in box and describes it to the model, so it does not try the network where there is none. */
export function sandboxTool(box: Sandbox): Tool {
	const allowed = box.offline?.()
		? 'Anything is allowed there, but it has no network: packages cannot be downloaded, so use what the image provides. '
		: 'Anything is allowed there: install packages, run code, use the network. ';
	return defineTool({
		name: sandboxName,
		description: 'Run a shell command (sh -c) in an isolated Linux container. ' + allowed +
			"Only /workspace, the working directory, persists between calls in this conversation; the user's own files and machine are not reachable.",
		input: z.object({
			command: z.string(),
			timeout: z.number().int().min(1).max(sandboxMaxTimeout / 1000).optional().describe('Seconds; default ' + sandboxDefaultTimeout / 1000),
		}),
		prompt: "Use the sandbox for isolated calculations, experiments and installed skill scripts; it needs no permission inside its container. It cannot access the user's host projects. When coding-agent tools are available, hand work on those projects to a coding agent.",
		run: call => box.exec(call.conversationId, call.input.command, (call.input.timeout ?? 0) * 1000, call.signal),
	});
}
