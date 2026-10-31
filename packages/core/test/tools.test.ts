import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, emptyHooks, run, Store, type Event, type llm } from '../src';
import { openBun } from '../src/sqlite/bun';

/** scripted calls tool once with args, then answers with text. */
function scripted(name: string, args: string): llm.Model {
	let step = 0;
	return {
		ref: { provider: 'test', model: 'scripted', effort: '' },
		info: { id: 'scripted', tools: true, known: false },
		async stream() {
			if (step++ === 0) return { text: '', reasoning: '', signature: '', calls: [{ id: 'c1', name, arguments: args }] };
			return { text: 'done', reasoning: '', signature: '', calls: [] };
		},
	};
}

const echo = defineTool({
	name: 'echo', description: 'Echo a count.',
	input: z.object({ count: z.number().int().min(1), label: z.string().optional() }),
	run: async call => ({ doubled: call.input.count * 2, label: call.input.label ?? '' }),
});

async function call(args: string) {
	const s = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-tools-')), 'db.sqlite'))).open();
	const c = s.create();
	const m = s.begin(c.id, 'r1', 'go', 'test/scripted');
	const events: Event[] = [];
	await run(new AbortController().signal, s, scripted('echo', args), { tools: [echo], hooks: emptyHooks(), owner: true }, c.id, m, '', e => { events.push(e); });
	s.close();
	return events;
}

test('a tool defined by a zod schema is offered as JSON Schema', () => {
	expect(echo.parameters).toEqual({
		type: 'object',
		properties: { count: { type: 'integer', minimum: 1 }, label: { type: 'string' } },
		required: ['count'],
		additionalProperties: false,
	});
});

test('the engine runs a tool only with arguments its schema accepts', async () => {
	const ok = await call('{"count":2,"extra":true}');
	expect(ok.find(e => e.kind === 'tool-output')?.output).toEqual({ doubled: 4, label: '' });
	const bad = await call('{"count":"two"}');
	expect(bad.find(e => e.kind === 'tool-output')).toBeUndefined();
	const failed = bad.find(e => e.kind === 'tool-failed');
	expect(failed?.error).toContain('invalid tool arguments');
	expect(failed?.error).toContain('count');
});
