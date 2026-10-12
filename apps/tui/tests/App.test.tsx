import { expect, test } from 'bun:test';
import { act } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { MobClient, type ChatMessage, type Snapshot } from '@mob/client';
import { App } from '../src/App';

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

function fixture(initialMessages: ChatMessage[] = []) {
	const snapshots: Record<string, Snapshot> = {
		first: { model: 'demo/echo', active: false, messages: initialMessages },
		second: { model: 'demo/echo', active: false, messages: [] },
	};
	let submitted = '';
	let replies = 0;
	const client = new MobClient(
		{ url: 'http://fixture', token: 'fixture-token' },
		{
			fetch: (async (url, init) => {
				const path = new URL(String(url)).pathname;
				if (path === '/api/conversations') return Response.json([conversation, second]);
				if (path.startsWith('/api/conversations/')) return Response.json(snapshots[path.split('/')[3]]);
				if (path === '/api/chat') {
					const body = JSON.parse(String(init?.body));
					submitted = body.text ?? '';
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
	return { client, initial: snapshots.first, submitted: () => submitted };
}

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
