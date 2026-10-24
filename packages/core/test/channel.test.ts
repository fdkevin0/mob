import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, clientWeChat, ConversationService, DemoModel, ReplyError, Store, newID, type llm, type Models, type Reply } from '../src';
import { openBun } from '../src/sqlite/bun';

/** thinker reasons before it answers. */
const thinker: llm.Model = {
	ref: { provider: 'test', model: 'thinker' } as llm.Ref,
	info: { id: 'thinker', context: 100000 } as llm.Info,
	async stream(_req, emit) {
		await emit('reasoning', 'secret plan');
		await emit('text', 'hello');
		return { text: 'hello', reasoning: '', calls: [] } as unknown as llm.Result;
	},
};

function bridge(model: llm.Model = thinker) {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-channel-')), 'mob.sqlite'))).open();
	const models: Models = { default: () => 'test/thinker', resolve: () => model, setDefault: () => model.ref, list: async () => [] };
	const conversation = new ConversationService(store, models);
	return new Bridge('Test', clientWeChat, store, conversation, {
		help: 'Connected.',
		approvals: () => '\n\napprove?',
		stale: id => 'stale ' + id,
		failed: err => '\nfailed: ' + err.message,
		unsupported: 'unsupported',
		empty: 'empty',
	});
}

const signal = () => new AbortController().signal;

test('answer shows only the turn’s text', async () => {
	expect((await bridge().answer({ key: 'k', owner: true, text: 'hi' }, signal())).text).toBe('hello');
});

test('answer runs commands', async () => {
	const b = bridge();
	const help = await b.answer({ key: 'k', owner: false, text: '/help' }, signal());
	expect(help.text).toStartWith('Connected.\n\n');
	expect(help.text).toContain('/approve');
	expect(b.store.list()).toEqual([]);
	expect((await b.answer({ key: 'k', owner: false, text: '/new' }, signal())).text).toBe('New conversation started.');
	expect(b.store.setting<string>('k')).toBeTruthy();
	const stale = newID();
	expect(await b.answer({ key: 'k', owner: true, text: '/approve ' + stale }, signal())).toEqual({ text: 'stale ' + stale, settled: stale });
});

test('deliver answers and sends once', async () => {
	const b = bridge();
	let answers = 0, sends = 0;
	const answer = async (): Promise<Reply> => { answers++; return { text: 'hi' }; };
	const send = async () => { sends++; };
	await b.deliver('m1', answer, send, signal());
	await b.deliver('m1', answer, send, signal());
	expect([answers, sends]).toEqual([1, 1]);
	expect(b.store.delivery('m1')?.state).toBe('sent');
	// A send that fails is not retried.
	await expect(b.deliver('m2', answer, async () => { throw new Error('network'); }, signal())).rejects.toThrow('uncertain');
	expect(b.store.delivery('m2')?.state).toBe('failed-or-unknown');
	// A failed answer is still sent, then thrown.
	const failing = async (): Promise<Reply> => { throw new ReplyError({ text: 'sorry' }, new Error('broke')); };
	let sent = '';
	await expect(b.deliver('m3', failing, async r => { sent = r.text; }, signal())).rejects.toThrow('broke');
	expect([sent, b.store.delivery('m3')?.state]).toEqual(['sorry', 'processing-failed']);
	// A send a restart interrupted is reported, not repeated.
	b.store.acceptDelivery('m4', 'processing');
	b.store.updateDelivery('m4', 'sending', 'hi');
	expect(() => b.accept('m4')).toThrow('uncertain');
	expect(b.store.delivery('m4')?.state).toBe('failed-or-unknown');
});

test('a guest’s demo turn concludes with its text', async () => {
	const reply = await bridge(new DemoModel()).answer({ key: 'k', owner: false, text: 'hey' }, signal());
	expect(reply.text).toContain('Received: hey');
});
