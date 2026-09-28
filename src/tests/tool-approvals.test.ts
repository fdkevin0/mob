import { describe, it, expect } from 'vitest';
import {
	ToolApprovals,
	APPROVAL_TTL_MS,
	approvalCallbackData,
	parseApprovalCallback,
	renderApprovalRequest,
	renderContinuationPrompt,
	renderDenialNote,
	type ApprovalStore,
	type PendingApproval,
} from '../features/agent/tool-approvals';
import { withApproval } from '../features/agent/tools/approval';
import { tool } from 'ai';
import { z } from 'zod';

/** In-memory `ApprovalStore` — the DO SQLite stand-in for unit tests. */
function fakeStore(): ApprovalStore & { rows: Map<string, PendingApproval> } {
	const rows = new Map<string, PendingApproval>();
	return {
		rows,
		insert: (row) => void rows.set(row.id, row),
		getById: (id) => rows.get(id) ?? null,
		deleteById: (id) => void rows.delete(id),
		deleteAll: () => void rows.clear(),
	};
}

/** A module under test with a settable clock and deterministic ids. */
function makeApprovals() {
	const store = fakeStore();
	let nowMs = 1_000_000;
	let seq = 0;
	const approvals = new ToolApprovals({
		store,
		now: () => nowMs,
		newId: () => `apr-${++seq}`,
	});
	return { approvals, store, advance: (ms: number) => (nowMs += ms) };
}

/**
 * Tests the **Tool approval** core (docs/adr/0039, PRD #98): the request →
 * pending → approve/deny/expire state machine, requester-or-admin enforcement,
 * lazy TTL expiry, /clear voiding, the callback codec, and the `withApproval`
 * wrapper (a gated tool never executes in the requesting turn). Pure module +
 * in-memory fakes + fixed clock — no DO, no Telegram.
 */
describe('ToolApprovals.request', () => {
	it('persists independent snapshots with the TTL', () => {
		const { approvals, store } = makeApprovals();
		const row = approvals.request('run_shell', { command: 'ls -la' }, 42);
		expect(store.rows.size).toBe(1);
		expect(row.expiresAt - row.createdAt).toBe(APPROVAL_TTL_MS);
		expect(row.argsJson).toBe(JSON.stringify({ command: 'ls -la' }));
		const second = approvals.request('run_shell', { command: 'pwd' }, 42);
		expect(store.rows.size).toBe(2);
		expect(second.id).not.toBe(row.id);
	});
});

describe('ToolApprovals.decide — approve', () => {
	it('by the requester, consumes the row; a second tap answers stale/unknown', () => {
		const { approvals, store } = makeApprovals();
		const row = approvals.request('run_shell', { command: 'ls' }, 42);
		const decided = approvals.decide(row.id, 'approve', { userId: 42, isAdmin: false });
		expect(decided.kind).toBe('approved');
		if (decided.kind === 'approved') {
			expect(decided.approval.argsJson).toBe(row.argsJson);
		}
		expect(store.rows.size).toBe(0);
		const again = approvals.decide(row.id, 'approve', { userId: 42, isAdmin: false });
		expect(again.kind === 'stale' && again.reason === 'unknown').toBe(true);
	});
});

describe('ToolApprovals.decide — deny', () => {
	it('by the requester, consumes the row', () => {
		const { approvals, store } = makeApprovals();
		const row = approvals.request('run_shell', { command: 'rm -rf /tmp/x' }, 42);
		const decided = approvals.decide(row.id, 'deny', { userId: 42, isAdmin: false });
		expect(decided.kind).toBe('denied');
		expect(store.rows.size).toBe(0);
	});
});

describe('ToolApprovals.decide — requester-or-admin enforcement', () => {
	it('a bystander is unauthorized; the admin backstop may decide', () => {
		const { approvals } = makeApprovals();
		const row = approvals.request('run_shell', { command: 'ls' }, 42);
		const bystander = approvals.decide(row.id, 'approve', { userId: 99, isAdmin: false });
		expect(bystander.kind).toBe('unauthorized');
		const admin = approvals.decide(row.id, 'approve', { userId: 99, isAdmin: true });
		expect(admin.kind).toBe('approved');
	});
});

describe('ToolApprovals.decide — lazy TTL expiry', () => {
	it('past the TTL drops the row and answers stale/expired', () => {
		const { approvals, store, advance } = makeApprovals();
		const row = approvals.request('run_shell', { command: 'ls' }, 42);
		advance(APPROVAL_TTL_MS + 1);
		const decided = approvals.decide(row.id, 'approve', { userId: 42, isAdmin: false });
		expect(decided.kind === 'stale' && decided.reason === 'expired').toBe(true);
		expect(store.rows.size).toBe(0);
	});
});

describe('ToolApprovals.voidAll', () => {
	it('clears every pending row (the /clear path)', () => {
		const { approvals, store } = makeApprovals();
		approvals.request('run_shell', { command: 'a' }, 42);
		approvals.request('run_shell', { command: 'b' }, 42);
		approvals.voidAll();
		expect(store.rows.size).toBe(0);
	});
});

describe('approval callback codec', () => {
	it('roundtrips approve and deny; rejects foreign namespace, unknown verb, missing id, undefined', () => {
		const parsed = parseApprovalCallback(approvalCallbackData('apr-7', 'approve'));
		expect(parsed?.id).toBe('apr-7');
		expect(parsed?.verb).toBe('approve');
		const denied = parseApprovalCallback(approvalCallbackData('apr-7', 'deny'));
		expect(denied?.verb).toBe('deny');
		expect(parseApprovalCallback('sched:cancel:x')).toBeNull();
		expect(parseApprovalCallback('apr:z:x')).toBeNull();
		expect(parseApprovalCallback('apr:y:')).toBeNull();
		expect(parseApprovalCallback(undefined)).toBeNull();
	});
});

describe('withApproval wrapper', () => {
	it('files a request and never runs the gated execute in the requesting turn', async () => {
		let executed = 0;
		const requests: Array<{ toolName: string; args: unknown }> = [];
		const gated = tool({
			description: 'test tool',
			inputSchema: z.object({ command: z.string() }),
			execute: async () => {
				executed += 1;
				return { ok: true };
			},
		});
		const wrapped = withApproval('run_shell', gated, {
			request: async (toolName, args) => {
				requests.push({ toolName, args });
				return { id: 'apr-1' };
			},
		});
		const result = (await wrapped.execute?.({ command: 'ls' }, { toolCallId: 't1', messages: [], context: undefined })) as Record<string, unknown>;
		expect(executed).toBe(0);
		expect(requests.length === 1 && requests[0].toolName === 'run_shell').toBe(true);
		expect(result.pendingApproval === true && result.approvalId === 'apr-1').toBe(true);
		expect(typeof wrapped.description === 'string' && wrapped.description.includes('approval')).toBe(true);
	});
});

describe('renderers', () => {
	it('request shows the exact command + approve/deny; continuation carries input + result; denial names the denied action', () => {
		const row: PendingApproval = {
			id: 'apr-1',
			toolName: 'run_shell',
			argsJson: JSON.stringify({ command: 'npm install left-pad' }),
			requestedBy: 42,
			createdAt: 0,
			expiresAt: APPROVAL_TTL_MS,
		};
		const view = renderApprovalRequest(row);
		expect(view.text.includes('run_shell') && view.text.includes('npm install left-pad')).toBe(true);
		expect(view.keyboard[0].length).toBe(2);
		const prompt = renderContinuationPrompt(row, JSON.stringify({ exitCode: 0 }));
		expect(prompt.includes('run_shell') && prompt.includes('exitCode')).toBe(true);
		const note = renderDenialNote(row);
		expect(note.includes('denied') && note.includes('npm install left-pad')).toBe(true);
	});
});
