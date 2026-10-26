// Capture production prompts offline; optionally replay one model decision per case. No tools execute.
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConversationService, OpenAIModel, Store, defaultTools, emptyHooks, newID, run, sandboxTool, type llm, type Message } from '@mob/core';
import { summarize } from '@mob/core/chat/compact';
import { openBun } from '@mob/core/sqlite/bun';
import { Service } from '../src/agents/service';
import { tools } from '../src/agents/tools';
import { cases, type Case } from './prompts/cases';

const requestSchema = z.object({
	system: z.string(), maxTokens: z.number().int().positive().optional(),
	messages: z.array(z.object({
		role: z.enum(['system', 'user', 'assistant', 'tool']), text: z.string(),
		reasoning: z.string().optional(), signature: z.string().optional(),
		toolCallId: z.string().optional(), toolName: z.string().optional(),
		toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })).optional(),
	})),
	tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })).optional(),
});
const suiteSchema = z.object({
	version: z.literal(1), revision: z.string(),
	cases: z.array(z.object({ id: z.string(), rubric: z.array(z.string()), request: requestSchema })).min(1),
});
export type Suite = z.infer<typeof suiteSchema>;

export async function capture(c: Case): Promise<llm.Request> {
	const store = new Store(openBun(':memory:')).open();
	const requests: llm.Request[] = [];
	const model: llm.Model = {
		ref: { provider: 'eval', model: 'capture', effort: '' },
		info: { id: 'capture', tools: true, known: true, context: 64000, output: 4096 },
		stream: async request => {
			requests.push(structuredClone(request));
			return { text: 'Captured offline.', reasoning: '', signature: '', calls: [] };
		},
	};
	try {
		const conversation = store.create();
		for (const text of c.history ?? []) store.say(conversation.id, text);
		if (c.tool) {
			const m = store.begin(conversation.id, newID(), 'Read the requested information.', 'eval/capture');
			m.parts = [{ type: 'tool-' + c.tool.name, toolCallId: 'fixture-call', input: c.tool.input, output: c.tool.output, state: 'output-available' }];
			store.save(m, 'complete', '');
		}
		if (c.kind === 'summary') {
			const [, , error] = await summarize(new AbortController().signal, model, c.previous ?? '', store.history(conversation.id), 2000);
			if (error) throw error;
		} else {
			const offered = [...defaultTools(), sandboxTool({ exec: async () => { throw new Error('evaluation must never run a command'); } })];
			if (c.kind === 'manager') offered.push(...tools(new Service(store, new ConversationService(store), '/unused-evaluation-workspace')));
			const message: Message = store.begin(conversation.id, newID(), c.text, 'eval/capture');
			await run(new AbortController().signal, store, model, {
				tools: offered, hooks: emptyHooks(), owner: true,
				entries: [{ kind: 'service', name: 'github', description: 'GitHub repositories and issues', use: 'Find the relevant GitHub tool.' }],
			}, conversation.id, message, '', () => {});
		}
		if (requests.length !== 1) throw new Error(`${c.id}: expected one request, got ${requests.length}`);
		return requests[0];
	} finally { store.close(); }
}

/** Replay returns proposals only; tool arguments are recorded, never dispatched. */
export async function replay(suite: Suite, model: llm.Model) {
	const results = [];
	for (const c of suite.cases) {
		const started = Date.now();
		let result: llm.Result = { text: '', reasoning: '', signature: '', calls: [] }, error: string | undefined;
		// shortcut: one decision per case; add scripted tool responses when multi-step failures need evaluation.
		try { result = await model.stream(c.request, () => {}, AbortSignal.timeout(120000)); }
		catch (e) { error = e instanceof Error ? e.message : String(e); }
		results.push({
			id: c.id, rubric: c.rubric,
			requestHash: createHash('sha256').update(JSON.stringify(c.request)).digest('hex'),
			text: result.text, calls: result.calls, usage: result.usage, elapsedMs: Date.now() - started, error,
		});
	}
	return { version: 1, revision: suite.revision, model: model.ref, results };
}

if (import.meta.main) {
	const { values } = parseArgs({ options: {
		input: { type: 'string' }, url: { type: 'string' }, model: { type: 'string' },
		'key-file': { type: 'string' }, help: { type: 'boolean' },
	} });
	if (values.help) {
		console.log('Offline: bun apps/mob/scripts/prompt-eval.ts > /tmp/mob-prompts.json\nReplay: bun apps/mob/scripts/prompt-eval.ts --input /tmp/mob-prompts.json --url http://localhost:1234/v1 --model MODEL [--key-file PATH]\nReplay sends synthetic prompts to that endpoint; proposed tool calls never execute. Grade the recorded rubrics manually.');
	} else {
		if (!!values.url !== !!values.model || (values['key-file'] && !values.url)) throw new Error('--url and --model are required together; --key-file is only for replay');
		let suite: Suite;
		if (values.input) suite = suiteSchema.parse(await Bun.file(values.input).json());
		else {
			const revision = await Bun.$`git rev-parse HEAD`.text();
			suite = { version: 1, revision: revision.trim(), cases: [] };
			for (const c of cases) suite.cases.push({ id: c.id, rubric: c.rubric, request: await capture(c) });
		}
		const report = values.url && values.model ? await replay(suite, new OpenAIModel(
			{ provider: 'eval', model: values.model, effort: '' },
			{ id: values.model, tools: true, known: false },
			{ baseURL: values.url, key: values['key-file'] ? (await Bun.file(values['key-file']).text()).trim() : '' },
		)) : suite;
		await Bun.write(Bun.stdout, JSON.stringify(report, null, 2) + '\n');
		if ('results' in report && report.results.some(r => r.error)) process.exitCode = 1;
	}
}
