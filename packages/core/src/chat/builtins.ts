// The commands about conversations and models, and the transcript commands
// (/model, /models, /compact) answered through the chat stream.
import { parseRef, refString, type Group, type Info } from '../llm/llm';
import { cell, choices, clientEmail, clientTelegram, clientTUI, clientWeb, clientWeChat, decide as decideAction, openConversation, type Argument, type Command, type CommandCall, type Suggestion } from './commands';
import { summarize, summaryTokens, transcript, transcriptUsage, type Requests } from './compact';
import type { ChatRequest, ConversationService } from './conversation';
import { CommandError } from './conversation';
import { recordRequests, since } from './engine';
import type { Event } from './events';
import { isAbort } from './running';
import { newID, NotFound } from './sql';
import { rememberAlways, rememberConversation, type Message } from './store';
import { duration, usageMarkdown } from './usage';

const everyClient = [clientWeb, clientTUI, clientTelegram, clientWeChat, clientEmail];
const messaging = [clientTelegram, clientWeChat, clientEmail];
/** browsing are the clients that can show conversations to pick from. */
const browsing = [clientWeb, clientTUI, clientTelegram];

export function builtins(s: ConversationService): Command[] {
	const modelChoices = async (signal?: AbortSignal): Promise<Suggestion[]> => {
		const list: Suggestion[] = [];
		for (const g of await s.models?.list('', signal) ?? []) for (const m of g.models) {
			const ref = g.provider + '/' + m.id;
			list.push({ value: ref, label: ref, detail: describe(m) });
		}
		return list;
	};
	const modelOrDefault: Argument = async call => [{ value: 'default', label: 'default', detail: 'Follow or set the default model' }, ...await modelChoices(call.signal)];
	const defaultModel: Argument = async (call, prior) => (prior[0] === 'default' ? modelChoices(call.signal) : []);
	const conversations: Argument = () => s.store.list().map(c => ({ value: c.id, label: c.title, detail: c.id }));
	const pending = (id: string): Suggestion[] => s.pending(id).map(p => ({ value: p.id, label: p.id, detail: p.tool }));
	const approvals: Argument = call => pending(call.conversationId);
	const reply = async (markdown: string) => ({ markdown });

	// decide resolves the named approval, or the only pending one when no ID
	// is given. /approve may remember the approval; /deny may say why.
	const decide = (approved: boolean) => async (call: CommandCall) => {
		const form = approved ? '/approve [ID] [conversation|always]' : '/deny [ID] [reason]';
		let id = '', rest = call.rest.trim();
		if (call.fields.length && call.fields[0].length === 32) { id = call.fields[0]; rest = rest.slice(id.length).trim(); }
		const a: { kind: string; approved: boolean; approvalId?: string; reason?: string; remember?: string } = { kind: decideAction, approved };
		if (!approved) a.reason = rest || undefined;
		else if (rest === '' || rest === rememberConversation || rest === rememberAlways) a.remember = rest || undefined;
		else return { markdown: 'Use `' + form + '`.' };
		if (!id) {
			const list = pending(call.conversationId);
			if (list.length !== 1) return { markdown: `${list.length} requests are pending; use \`${form}\`.` };
			id = list[0].value;
		}
		a.approvalId = id;
		return { action: a };
	};

	return [
		{ name: 'model', usage: '/model [NAME | default [NAME]]', summary: "Show or switch this conversation's model", clients: everyClient, transcript: true, args: [modelOrDefault, defaultModel] },
		{ name: 'models', usage: '/models [FILTER]', summary: 'List available models', clients: everyClient, transcript: true },
		{ name: 'compact', usage: '/compact', summary: 'Summarize the conversation so far, so later turns read the summary in its place', clients: everyClient, transcript: true },
		{
			name: 'new', usage: '/new', summary: 'Start a new conversation', clients: everyClient,
			run: async () => ({ markdown: 'New conversation started.', action: { kind: openConversation, conversationId: s.store.create().id } }),
		},
		{
			name: 'list', usage: '/list', summary: 'List conversations', clients: browsing,
			run: async call => {
				let b = '| Conversation | ID |\n| --- | --- |\n';
				// The conversation the command came from is listed, even before anything was said in it.
				const list = s.store.list();
				if (!list.some(c => c.id === call.conversationId)) list.unshift(...s.store.list(true).filter(c => c.id === call.conversationId));
				for (const c of list) {
					let title = cell(c.title);
					if (c.id === call.conversationId) title = '**' + title + '** (current)';
					b += `| ${title} | \`${c.id}\` |\n`;
				}
				return { markdown: b + '\nSwitch with `/open ID`.' };
			},
		},
		{
			name: 'open', usage: '/open ID', summary: 'Switch to a conversation', clients: browsing, args: [conversations],
			run: async call => {
				if (call.fields.length !== 1) return { markdown: 'Use `/open ID`; `/list` shows conversations.' };
				const id = call.fields[0];
				try { s.store.history(id); } catch (e) {
					if (e instanceof NotFound) return { markdown: 'No conversation has ID `' + cell(id) + '`.' };
					throw e;
				}
				return { action: { kind: openConversation, conversationId: id } };
			},
		},
		{ name: 'approve', usage: '/approve [ID] [conversation|always]', summary: 'Approve a pending tool request, optionally remembering it', clients: everyClient, args: [approvals, choices(rememberConversation, rememberAlways)], run: decide(true) },
		{ name: 'deny', usage: '/deny [ID] [reason]', summary: 'Deny a pending tool request, optionally saying why', clients: everyClient, args: [approvals], run: decide(false) },
		{
			name: 'grants', usage: '/grants', summary: 'List remembered approvals', clients: everyClient, ownerOnly: true,
			run: async () => {
				const grants = s.store.grants();
				if (!grants.length) return reply('No approvals are remembered. Approve with `/approve ID always` or `/approve ID conversation` to remember one.');
				let b = '| Tool | Covers | Where | Revoke |\n| --- | --- | --- | --- |\n';
				for (const g of grants) {
					const where = g.conversationId ? 'conversation `' + g.conversationId + '`' : 'every conversation';
					b += `| ${cell(g.tool)} | ${cell(g.scope || 'every call')} | ${where} | \`/revoke ${g.id}\` |\n`;
				}
				return reply(b + '\n`/revoke all` forgets every one.');
			},
		},
		{
			name: 'revoke', usage: '/revoke ID|all', summary: 'Forget a remembered approval', clients: everyClient, ownerOnly: true,
			args: [() => [{ value: 'all', label: 'all', detail: 'every remembered approval' }, ...s.store.grants().map(g => ({ value: g.id, label: g.tool, detail: g.scope }))]],
			run: async call => {
				if (call.fields.length !== 1) return reply('Use `/revoke ID` or `/revoke all`; `/grants` lists them.');
				const n = s.store.revoke(call.fields[0]);
				if (!n) return reply('No remembered approval has ID `' + cell(call.fields[0]) + '`.');
				return reply(`Forgot ${n} remembered approval(s); those calls will ask again.`);
			},
		},
		{
			name: 'memories', usage: '/memories', summary: 'List saved facts', clients: everyClient, ownerOnly: true,
			run: async () => {
				const facts = s.store.facts();
				if (!facts.length) return reply('No facts are saved. Ask the model to remember one.');
				let b = '| Fact | Read in | Forget |\n| --- | --- | --- |\n';
				for (const f of facts) b += `| ${cell(f.text)} | ${f.owner ? 'all your conversations' : 'conversation `' + f.conversationId + '`'} | \`/forget ${f.id}\` |\n`;
				return reply(b + '\n`/forget all` forgets every one.');
			},
		},
		{
			name: 'forget', usage: '/forget ID|all', summary: 'Forget a saved fact', clients: everyClient, ownerOnly: true,
			args: [() => [{ value: 'all', label: 'all', detail: 'every saved fact' }, ...s.store.facts().map(f => ({ value: f.id, label: f.text }))]],
			run: async call => {
				if (call.fields.length !== 1) return reply('Use `/forget ID` or `/forget all`; `/memories` lists them.');
				const n = s.store.forget(call.fields[0]);
				if (!n) return reply('No saved fact has ID `' + cell(call.fields[0]) + '`.');
				return reply(`Forgot ${n} fact(s).`);
			},
		},
		{
			name: 'usage', usage: '/usage', summary: 'Show the tokens, cache and cost this conversation used, by model', clients: everyClient,
			run: async call => {
				const summary = s.store.conversationUsage(call.conversationId).get(call.conversationId);
				if (!summary) return reply('This conversation has not used any tokens yet, or its agent does not report them.');
				let text = usageMarkdown(summary);
				const t = s.store.task(call.conversationId);
				if (t && t.conversationId === call.conversationId) text += `\n\nThe task's latest update came ${duration(t.updatedAt - t.createdAt)} after it started.`;
				return reply(text);
			},
		},
		{ name: 'stop', usage: '/stop', summary: 'Stop the reply in progress', clients: [clientTelegram], run: async call => reply(s.stop(call.conversationId) ? 'Stopping.' : 'Nothing is running.') },
		{ name: 'help', usage: '/help', summary: 'Show commands', clients: messaging, run: async call => reply(s.commands.help(call.client)) },
	];
}

const modelHelp = '/model shows this conversation\'s model · /model NAME switches it · /model default [NAME] follows or sets the default · /models [FILTER] lists models';
/** perProvider bounds /models output; a filter narrows a long list. */
const perProvider = 25;

/** command answers a transcript command and records it with its reply; it is never sent to a model. */
export async function command(s: ConversationService, input: ChatRequest, signal: AbortSignal, emit: (e: Event) => Promise<void>) {
	// A retried request must not switch models again after later choices.
	if (s.store.hasRequest(input.requestId)) throw new CommandError(409, 'request already accepted; refresh history');
	const space = input.text.indexOf(' ');
	const name = space < 0 ? input.text : input.text.slice(0, space);
	const args = space < 0 ? '' : input.text.slice(space + 1).trim();
	let reply = '', used: Requests = [], err: Error | undefined;
	try {
		if (name === '/models') reply = await models(s, input.id, args, signal);
		else if (name === '/compact') [reply, used] = await compact(s, input.id, signal);
		else reply = switchModel(s, input.id, args, !!input.owner);
	} catch (e) {
		err = e as Error;
		used = (e as { requests?: Requests }).requests ?? used;
	}
	// A stopped /compact is recorded, with what its summary requests cost before it stopped.
	const stopped = !!err && signal.aborted && name === '/compact';
	if (err && !stopped) throw err;
	if (stopped) reply = 'Summarizing was stopped; nothing was summarized.';
	let message: Message;
	try {
		message = s.store.command(input.id, input.requestId, input.text, reply);
	} catch (e) {
		if (s.store.hasRequest(input.requestId)) throw new CommandError(409, 'request already accepted; refresh history');
		throw e;
	}
	const usage = transcriptUsage(used);
	if (usage || stopped) {
		message.usage = usage;
		s.store.save(message, stopped ? 'cancelled' : 'complete', stopped ? err!.message : '');
	}
	if (usage) {
		recordRequests(s.store, used, input.id, message.id);
		await emit({ kind: 'usage', usage });
	}
	if (stopped) throw err;
	const id = newID();
	for (const e of [
		{ kind: 'turn-started', messageId: message.id }, { kind: 'step-started' }, { kind: 'segment-started', segment: 'text', id },
		{ kind: 'segment-delta', segment: 'text', id, text: reply }, { kind: 'segment-finished', segment: 'text', id }, { kind: 'step-finished' }, { kind: 'turn-finished', reason: 'stop' },
	] as Event[]) await emit(e);
}

/**
 * compact summarizes every message since the conversation's summary, so later
 * turns read the summary in their place. A conversation without a model or
 * messages to summarize is told so in the reply.
 */
async function compact(s: ConversationService, id: string, signal: AbortSignal): Promise<[string, Requests]> {
	const ref = s.model(id);
	if (!ref) return ['No model is configured to write the summary; pick one with /model.', []];
	let model;
	try { model = s.models!.resolve(ref); } catch (e) { return ['Model ' + ref + ' is unavailable to write the summary: ' + (e as Error).message + '.', []]; }
	const summary = s.store.summary(id);
	const covered = since(s.store.history(id), summary.through).filter(m => transcript(m) !== '');
	if (!covered.length) return ['There is nothing new to summarize.', []];
	const [text, usage, err] = await summarize(signal, model, summary.text, covered, summaryTokens);
	if (err) {
		if (signal.aborted || isAbort(err)) throw Object.assign(err, { requests: usage });
		return ['The conversation was not summarized: ' + err.message + '.', usage];
	}
	s.store.summarize(id, { text, through: covered[covered.length - 1].id });
	return [`Summarized ${covered.length} messages; later turns read the summary in their place.`, usage];
}

/** describe is one line about a model: its name and what it can do. */
export function describe(i: Info) {
	const traits: string[] = [];
	if (i.name && i.name !== i.id) traits.push(i.name);
	if (i.reasoning) traits.push('reasoning' + (i.efforts?.length ? ' (' + i.efforts.join('/') + ')' : ''));
	if (i.tools) traits.push('tools');
	if (i.vision) traits.push('images');
	if (i.context && i.context > 0) traits.push(`${Math.floor(i.context / 1000)}k context`);
	if (i.free) traits.push('free');
	else if (i.cost) traits.push(`$${i.cost.input}/$${i.cost.output} per 1M tokens`);
	return traits.join(' · ');
}

async function models(s: ConversationService, id: string, filter: string, signal: AbortSignal) {
	const current = s.model(id);
	const currentRef = parseRef(current);
	const groups: Group[] = await s.models?.list(filter, signal) ?? [];
	let b = `**Current model:** \`${current}\`\n`;
	if (!groups.length) return b + (filter ? `\nNo model matches ${JSON.stringify(filter)}.` : '\nNo providers yet. Add one with `mob provider add`.');
	for (const g of groups) {
		b += `\n### ${g.provider} (${g.name})\n\n`;
		if (g.error) b += `> **Warning:** ${g.error}\n\n`;
		for (const [i, m] of g.models.entries()) {
			if (i === perProvider) { b += `\n*… ${g.models.length - perProvider} more; narrow with \`/models FILTER\`.*\n`; break; }
			let ref = '`' + g.provider + '/' + m.id + '`';
			if (g.provider === currentRef?.provider && m.id === currentRef?.model) ref = '**' + ref + '** (current)';
			const d = describe(m);
			b += '- ' + ref + (d ? ' — ' + d : '') + '\n';
		}
	}
	const example = groups.find(g => g.models.length);
	return b + '\nSwitch with `/model NAME`, e.g. `/model ' + (example ? example.provider + '/' + example.models[0].id : 'provider/model') + '`.';
}

function switchModel(s: ConversationService, id: string, args: string, owner: boolean) {
	if (!args) {
		const current = s.model(id);
		if (!current) return 'No model is configured.\n' + modelHelp;
		let line = 'This conversation uses ' + current;
		try {
			const d = describe(s.models!.resolve(current).info);
			if (d) line += ' — ' + d;
		} catch (e) { line += ' (unavailable: ' + (e as Error).message + ')'; }
		if (!s.store.conversationModel(id)) line += ' (the default)';
		return line + '\n' + modelHelp;
	}
	if (!owner) return 'Only the owner of this Mob can switch models.';
	const space = args.indexOf(' ');
	const target = space < 0 ? args : args.slice(0, space);
	if (target === 'default') {
		const rest = space < 0 ? '' : args.slice(space + 1).trim();
		if (!rest) {
			s.store.setConversationModel(id, '');
			return 'This conversation now follows the default model, ' + s.models!.default() + '.';
		}
		try {
			return 'The default model is now ' + refString(s.models!.setDefault(rest)) + '. Conversations without their own /model choice use it.';
		} catch (e) { return (e as Error).message; }
	}
	let m;
	try { m = s.models!.resolve(args); } catch (e) { return (e as Error).message; }
	s.store.setConversationModel(id, refString(m.ref));
	const d = describe(m.info);
	return 'Switched this conversation to ' + refString(m.ref) + (d ? ' — ' + d : '') + '.';
}
