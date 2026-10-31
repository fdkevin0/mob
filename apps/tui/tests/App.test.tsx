import { expect, test } from 'bun:test';
import { act } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { MobClient, type ChatMessage, type Snapshot } from '@mob/client';
import { App, replySummary } from '../src/App';

const conversation = { id: 'first', title: 'Offline test', updatedAt: 1 };
const second = { id: 'second', title: 'Other session', updatedAt: 0 };

async function step(ui: Awaited<ReturnType<typeof testRender>>, action: () => unknown = () => {}) {
	await act(async () => {
		await action();
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	await ui.flush();
}

async function mount(f: ReturnType<typeof fixture>) {
	let ui!: Awaited<ReturnType<typeof testRender>>;
	await act(async () => {
		ui = await testRender(<App client={f.client} initial={f.initial} conversation={conversation} onExit={() => {}} />, {
			width: 80,
			height: 24,
		});
	});
	return ui;
}

function fixture(initialMessages: ChatMessage[] = [], pending?: 'absent' | 'accepted') {
	const snapshots: Record<string, Snapshot> = {
		first: { model: 'demo/echo', active: false, messages: initialMessages },
		second: { model: 'demo/echo', active: false, messages: [] },
	};
	let submitted = '';
	let replies = 0;
	const requests: { id: string; requestId: string; text: string }[] = [];
	let failPending!: () => void;
	const held = new Promise<Response>((_, reject) => {
		failPending = () => reject(new Error('Fixture transport unavailable'));
	});
	const client = new MobClient(
		{ url: 'http://fixture', token: 'fixture-token' },
		{
			fetch: (async (url, init) => {
				const path = new URL(String(url)).pathname;
				if (path === '/api/conversations') return Response.json([conversation, second]);
				if (path.startsWith('/api/conversations/')) return Response.json(snapshots[path.split('/')[3]]);
				if (path === '/api/chat') {
					const body = JSON.parse(String(init?.body));
					requests.push(body);
					submitted = body.text ?? '';
					if (pending && requests.length === 1) {
						if (pending === 'accepted')
							snapshots[body.id].messages = [
								...initialMessages,
								{ id: body.requestId, role: 'user', parts: [{ type: 'text', text: body.text }] },
								{ id: 'persisted-reply', role: 'assistant', parts: [{ type: 'text', text: 'Service already accepted this request' }] },
							];
						return held;
					}
					const text = body.approval
						? JSON.stringify({ approved: body.approval.approved, scope: body.approval.remember ?? 'once', reason: body.approval.reason })
						: `Received complete input (${submitted.length} characters)`;
					const message: ChatMessage = { id: `reply-${++replies}`, role: 'assistant', parts: [{ type: 'text', text }] };
					snapshots[body.id].messages = [message];
					const chunks = [
						{ type: 'start', messageId: message.id },
						{ type: 'text-start', id: 'text' },
						{ type: 'text-delta', id: 'text', delta: text },
						{ type: 'text-end', id: 'text' },
						{ type: 'finish' },
					];
					return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
						headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
					});
				}
				throw new Error(`Unexpected request ${path}`);
			}) as typeof fetch,
		},
	);
	return { client, initial: snapshots.first, submitted: () => submitted, requests, failPending };
}

async function switchTo(ui: Awaited<ReturnType<typeof testRender>>, title: string) {
	await step(ui, () => ui.mockInput.pressKey('F2'));
	await step(ui, () => ui.mockInput.typeText(title));
	await step(ui, () => ui.mockInput.pressEnter());
}

test('an undelivered send recovers after switching away, transport failure, and reopening', async () => {
	const f = fixture([], 'absent');
	const ui = await mount(f);
	const text = '恢复未送达\nasymmetric second line';
	try {
		await step(ui);
		await step(ui, () => ui.mockInput.pasteBracketedText(text));
		await step(ui, () => ui.mockInput.pressEnter());
		expect(f.requests).toHaveLength(1);
		await switchTo(ui, 'Other');
		expect(ui.captureCharFrame()).toContain('Other session');
		await switchTo(ui, 'Offline');
		expect(ui.captureCharFrame()).not.toContain('Ready');
		expect(ui.captureCharFrame()).not.toContain('Delivery not confirmed');
		expect(f.requests).toHaveLength(1);
		await switchTo(ui, 'Other');
		await step(ui, f.failPending);
		await switchTo(ui, 'Offline');
		expect(ui.captureCharFrame()).toContain('恢复未送达');
		expect(ui.captureCharFrame()).toContain('asymmetric second line');
		expect(ui.captureCharFrame()).toContain('Delivery not confirmed');
		expect(f.requests).toHaveLength(1);
		await step(ui, () => ui.resize(48, 16));
		expect(ui.captureCharFrame()).toContain('NOT automatically resent');
		await step(ui, () => ui.resize(80, 24));
		await step(ui, () => ui.mockInput.pressEnter());
		expect(f.requests).toHaveLength(2);
		expect(f.submitted()).toBe(text);
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test('a newer draft stays editable while the undelivered original remains visible for review', async () => {
	const f = fixture([], 'absent');
	const ui = await mount(f);
	const original = '原始未确认\noriginal asymmetric prompt';
	const draft = '新草稿保留\nnewer independent draft';
	try {
		await step(ui);
		await step(ui, () => ui.mockInput.pasteBracketedText(original));
		await step(ui, () => ui.mockInput.pressEnter());
		await step(ui, () => ui.mockInput.pasteBracketedText(draft));
		await switchTo(ui, 'Other');
		await step(ui, f.failPending);
		await switchTo(ui, 'Offline');
		expect(ui.captureCharFrame()).toContain('新草稿保留');
		expect(ui.captureCharFrame()).toContain('原始未确认');
		expect(ui.captureCharFrame()).toContain('original asymmetric prompt');
		expect(f.requests).toHaveLength(1);
		await step(ui, () => ui.mockInput.pressEnter());
		expect(f.requests).toHaveLength(2);
		expect(f.submitted()).toBe(draft);
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test('reopening a service-accepted request does not restore or automatically duplicate its prompt', async () => {
	const f = fixture([], 'accepted');
	const ui = await mount(f);
	try {
		await step(ui);
		await step(ui, () => ui.mockInput.pasteBracketedText('已经接受\nresponse lost, not request'));
		await step(ui, () => ui.mockInput.pressEnter());
		await switchTo(ui, 'Other');
		await step(ui, f.failPending);
		await switchTo(ui, 'Offline');
		const frame = ui.captureCharFrame();
		expect(frame).toContain('Service already accepted this request');
		expect(frame).toContain('Message · Enter sends');
		expect(frame).not.toContain('Unconfirmed send');
		expect(frame).not.toContain('Fixture transport unavailable');
		expect(frame.split('已经接受')).toHaveLength(2);
		expect(f.requests).toHaveLength(1);
		await step(ui, () => ui.mockInput.pressEnter());
		expect(f.requests).toHaveLength(1);
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test('a paste immediately followed by Enter sends the editor contents', async () => {
	const f = fixture();
	const ui = await mount(f);
	try {
		await step(ui);
		await step(ui, async () => {
			await ui.mockInput.pasteBracketedText('快速粘贴\nsecond line');
			ui.mockInput.pressEnter();
		});
		expect(f.submitted()).toBe('快速粘贴\nsecond line');
		expect(ui.captureCharFrame()).toContain('Received complete input');
		await step(ui, async () => {
			await ui.mockInput.pasteBracketedText('next message');
			ui.mockInput.pressEnter();
		});
		expect(f.submitted()).toBe('next message');
		await step(ui, () => ui.mockInput.pasteBracketedText('manual'));
		await step(ui, () => ui.mockInput.pressKey('j', { ctrl: true }));
		await step(ui, () => ui.mockInput.typeText('newline'));
		await step(ui, () => ui.mockInput.pressEnter());
		expect(f.submitted()).toBe('manual\nnewline');
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test('native terminal preserves a complete multiline paste and per-session drafts', async () => {
	const f = fixture();
	const ui = await mount(f);
	try {
		await step(ui);
		const text = '你好，终端\n' + Array.from({ length: 130 }, (_, i) => `row ${i} asymmetric content`).join('\n') + '\n最后一行';
		await step(ui, () => ui.mockInput.pasteBracketedText(text));
		await step(ui, () => ui.mockInput.pressKey('F2'));
		await step(ui, () => ui.mockInput.typeText('Other'));
		await step(ui, () => ui.mockInput.pressEnter());
		expect(ui.captureCharFrame()).toContain('Mob · TS pilot · Other session');
		await step(ui, () => ui.mockInput.pressKey('F2'));
		await step(ui, () => ui.mockInput.typeText('Offline'));
		await step(ui, () => ui.mockInput.pressEnter());
		expect(ui.captureCharFrame()).toContain('Mob · TS pilot · Offline test');
		await step(ui, () => ui.mockInput.pressEnter());
		expect(ui.captureCharFrame()).toContain('Received complete input');
		expect(f.submitted()).toBe(text);
		expect(ui.captureCharFrame()).toContain('Ready');
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test('terminal shows real tool output/error, expands full output, and fits a narrow frame', async () => {
	const f = fixture([
		{
			id: 'tools',
			role: 'assistant',
			parts: [
				{
					type: 'tool-read',
					toolCallId: 'ok',
					state: 'output-available',
					input: { path: 'test' },
					output: { result: 'A'.repeat(300) + 'unique-tail' },
				},
				{ type: 'tool-read', toolCallId: 'bad', state: 'output-error', input: { path: 'missing' }, errorText: 'fixture permission denied' },
			],
		},
	]);
	const ui = await mount(f);
	try {
		await step(ui);
		expect(ui.captureCharFrame()).toContain('F3 shows full details');
		expect(ui.captureCharFrame()).toContain('fixture permission denied');
		expect(ui.captureCharFrame()).not.toContain('unique-tail');
		await step(ui, () => ui.mockInput.pressKey('F3'));
		expect(ui.captureCharFrame()).toContain('unique-tail');
		await step(ui, () => ui.resize(48, 16));
		expect(ui.captureCharFrame()).toContain('^S stop');
		expect(ui.captureCharFrame()).toContain('^Q exit');
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test.each(['conversation', 'always', 'deny'])('terminal approval choice carries %s through the shared client', async (scope) => {
	const f = fixture([
		{
			id: 'pending',
			role: 'assistant',
			parts: [
				{
					type: 'tool-remember',
					toolCallId: 'call',
					state: 'approval-requested',
					input: { fact: 'test fact' },
					approval: { id: 'approval' },
				},
			],
		},
	]);
	const ui = await mount(f);
	try {
		await step(ui);
		await step(ui, () => ui.mockInput.pressKey('F4'));
		await step(ui, () => ui.mockInput.pressEnter());
		expect(ui.captureCharFrame()).toContain('The service determines');
		if (scope === 'conversation') {
			await step(ui, () => ui.resize(48, 16));
			expect(ui.captureCharFrame()).toContain('Always allow matching scope');
			await step(ui, () => ui.mockInput.pressKey('\x1b[6~'));
			expect(ui.captureCharFrame()).toContain('test fact');
			await step(ui, () => ui.resize(80, 24));
		}
		await step(ui, () => {
			for (let i = 0; i < (scope === 'conversation' ? 1 : scope === 'always' ? 2 : 3); i++) ui.mockInput.pressArrow('down');
		});
		await step(ui, () => ui.mockInput.pressEnter());
		if (scope === 'deny') {
			await step(ui, () => ui.mockInput.typeText('Wrong target'));
			await step(ui, () => ui.mockInput.pressEnter());
		}
		expect(ui.captureCharFrame()).toContain(scope === 'deny' ? 'Wrong target' : `"scope":"${scope}"`);
		expect(ui.captureCharFrame()).toContain(scope === 'deny' ? '"approved":false' : '"approved":true');
	} finally {
		await act(async () => {
			await ui.dispose();
		});
	}
});

test('a finished reply says its model, tokens, speed and time in one line', () => {
	const reply = (metadata: ChatMessage['metadata']): ChatMessage => ({ id: 'r', role: 'assistant', parts: [], metadata });
	expect(replySummary(reply({ model: 'anthropic/claude-sonnet-4-5', usage: { inputTokens: 12400, outputTokens: 1800 }, stats: { startedAt: 0, finishedAt: 14200, generationMs: 7400, timedOutput: 385 } })))
		.toBe('claude-sonnet-4-5 · 14k tok · 52 tok/s · 14s');
	expect(replySummary(reply({ model: 'codex', usage: { inputTokens: 500, outputTokens: 20 } }))).toBe('codex · 520 tok');
	expect(replySummary(reply({ model: 'demo/echo', command: true, usage: { inputTokens: 1, outputTokens: 1 } }))).toBe('');
	expect(replySummary(reply({ status: 'complete' }))).toBe('');
});
