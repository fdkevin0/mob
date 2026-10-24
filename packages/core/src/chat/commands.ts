// Slash commands: described once for help, completion and execution in every client.

export const clientWeb = 'web', clientTUI = 'tui', clientTelegram = 'telegram', clientWeChat = 'wechat', clientEmail = 'email';
/** interactive are the clients where people type commands into Mob itself. */
export const interactive = [clientWeb, clientTUI];

/**
 * CommandSpec describes a slash command. A transcript command is answered by
 * the chat stream and recorded in the conversation; any other runs through
 * Registry.run and only shows its result.
 */
export type CommandSpec = { name: string; usage: string; summary: string; clients: string[]; transcript?: boolean };

/** CommandRequest is text typed into a client: up to the cursor when completing, the whole input when running. */
export type CommandRequest = { client: string; conversationId?: string; text: string };

/** Suggestion replaces the last whitespace-separated token of the completed text. */
export type Suggestion = { value: string; label: string; detail?: string };

/** Action asks the client to do what only it can: change its view or decide an approval through its own stream. */
export type Action = { kind: string; conversationId?: string; approvalId?: string; approved?: boolean; reason?: string; remember?: string };

export const openConversation = 'open-conversation', decide = 'decide', openPlugins = 'open-plugins', composeMail = 'compose-mail';

/** CommandResult is what a client shows after running a command; handled is false for text to send as chat. */
export type CommandResult = { handled: boolean; markdown?: string; action?: Action };

/** CommandCall is one invocation; fields are the arguments and rest is the text after the command name. */
export type CommandCall = { client: string; conversationId: string; rest: string; fields: string[]; owner: boolean; signal?: AbortSignal };

/** Argument suggests values for one argument position; prior holds the arguments before it. */
export type Argument = (call: CommandCall, prior: string[]) => Suggestion[] | Promise<Suggestion[]>;

export type Command = CommandSpec & {
	args?: Argument[];
	/** ownerOnly commands refuse callers that do not own this Mob. */
	ownerOnly?: boolean;
	/** run answers a non-transcript command. */
	run?: (call: CommandCall) => Promise<Omit<CommandResult, 'handled'>>;
};

const maxSuggestions = 20;
const fieldsOf = (s: string) => s.split(/\s+/).filter(Boolean);

function parse(input: CommandRequest, owner: boolean): [string, CommandCall] {
	const text = input.text.trim();
	const space = text.indexOf(' ');
	const name = space < 0 ? text : text.slice(0, space);
	const rest = space < 0 ? '' : text.slice(space + 1).trim();
	return [name.replace(/^\//, ''), { client: input.client, conversationId: input.conversationId ?? '', rest, fields: fieldsOf(rest), owner }];
}

/** Registry holds every command. */
export class Registry {
	private commands: Command[] = [];

	register(...commands: Command[]) {
		for (const c of commands) {
			if (this.commands.some(o => o.name === c.name)) throw new Error('command registered twice: ' + c.name);
			if (!!c.transcript === !!c.run) throw new Error('command needs exactly one of transcript or run: ' + c.name);
			this.commands.push(c);
		}
	}

	private lookup(name: string, client: string) { return this.commands.find(c => c.name === name && c.clients.includes(client)); }

	/** transcript reports whether text is a transcript command in any client. */
	transcript(text: string) {
		const name = text.split(' ', 1)[0];
		return this.commands.some(c => c.transcript && '/' + c.name === name);
	}

	/** specs lists the commands a client understands. */
	specs(client: string): CommandSpec[] {
		return this.commands.filter(c => c.clients.includes(client)).map(c => {
			const spec: CommandSpec = { name: c.name, usage: c.usage, summary: c.summary, clients: c.clients };
			if (c.transcript) spec.transcript = true;
			return spec;
		});
	}

	/** help is one line per command a client understands. */
	help(client: string) { return this.specs(client).map(c => `${c.usage} — ${c.summary}`).join('\n'); }

	/** run executes a non-transcript command. Other text, transcript commands included, comes back unhandled. */
	async run(input: CommandRequest, owner: boolean, signal?: AbortSignal): Promise<CommandResult> {
		if (!input.text.startsWith('/') || /[\r\n]/.test(input.text)) return { handled: false };
		const [name, call] = parse(input, owner);
		const c = this.lookup(name, input.client);
		if (!c?.run) return { handled: false };
		if (c.ownerOnly && !owner) return { handled: true, markdown: 'Only the owner of this Mob can use /' + c.name + '.' };
		call.signal = signal;
		return { ...(await c.run(call)), handled: true };
	}

	/** complete suggests replacements for the last token of input.text. */
	async complete(input: CommandRequest, owner: boolean): Promise<Suggestion[]> {
		const text = input.text;
		if (!text.startsWith('/') || /[\r\n]/.test(text)) return [];
		let fields = fieldsOf(text);
		let prefix = '';
		if (!text.endsWith(' ') && !text.endsWith('\t')) { prefix = fields[fields.length - 1]; fields = fields.slice(0, -1); }
		if (!fields.length) return filter(this.specs(input.client).map(c => ({ value: '/' + c.name, label: c.usage, detail: c.summary })), prefix, false);
		const c = this.lookup(fields[0].replace(/^\//, ''), input.client);
		if (!c || fields.length - 1 >= (c.args?.length ?? 0) || (c.ownerOnly && !owner)) return [];
		// Model listings can refresh from vendors; typing must not wait on them.
		const [, call] = parse(input, owner);
		call.signal = AbortSignal.timeout(2000);
		return filter(await c.args![fields.length - 1](call, fields.slice(1)) ?? [], prefix, true);
	}
}

/** filter keeps prefix matches of the value before substring matches (of three or more characters) of the value or label. */
export function filter(list: Suggestion[], prefix: string, labels: boolean): Suggestion[] {
	prefix = prefix.toLowerCase();
	const word = prefix.replace(/^\//, '');
	const first: Suggestion[] = [], rest: Suggestion[] = [];
	for (const s of list) {
		const value = s.value.toLowerCase();
		if (value.startsWith(prefix) || value.replace(/^\//, '').startsWith(prefix)) first.push(s);
		else if (word.length >= 3 && (value.includes(word) || (labels && s.label.toLowerCase().includes(word)))) rest.push(s);
	}
	return [...first, ...rest].slice(0, maxSuggestions);
}

/** choices is an argument with fixed values. */
export const choices = (...values: string[]): Argument => () => values.map(v => ({ value: v, label: v }));

/** fence shows text verbatim in Markdown, whatever backticks it contains. */
export function fence(language: string, text: string) {
	let f = '```';
	while (text.includes(f)) f += '`';
	return f + language + '\n' + text.replace(/\n$/, '') + '\n' + f;
}

/** cell makes text safe inside a Markdown table cell. */
export const cell = (text: string) => fieldsOf(text).join(' ').replaceAll('|', '\\|');

/** replyJSON shows value as indented JSON under title. */
export const replyJSON = (title: string, value: unknown) => ({ markdown: title + '\n\n' + fence('json', JSON.stringify(value, null, 2)) });
