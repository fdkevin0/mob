/**
 * The **Tool approval** core (docs/adr/0039, PRD #98): the request → pending →
 * approve/deny/expire state machine for approval-gated **Built-in agent tools**
 * (`run_shell` first), over an injected store + clock. Approval is a **turn
 * boundary** — the gated tool never executes in the requesting turn; approving
 * enqueues a new turn that executes the persisted argument snapshot. This module
 * is the pure heart plus the surface codecs/renderers and the **Callback family**
 * descriptor (docs/adr/0048) — its `act` is
 * the only I/O this module does, run through the injected `CallbackCtx`.
 */
import type * as Telegram from 'telegram-bot-api-types';
import type { CallbackFamily } from '../../core/callback-family';

/** Pending approvals expire after an hour (docs/adr/0039): a forgotten request must not fire days later. */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/** A persisted pending approval: the tool call snapshot awaiting a human decision. */
export interface PendingApproval {
	id: string;
	toolName: string;
	/** The exact arguments the model proposed, serialized at request time — approval never re-runs the model. */
	argsJson: string;
	/** The initiating Principal's userId — the only non-admin who may decide (docs/adr/0039). */
	requestedBy: number;
	createdAt: number;
	expiresAt: number;
}

/** The DO-SQLite-backed persistence port (the `pending_approvals` table). */
export interface ApprovalStore {
	insert(row: PendingApproval): void;
	getById(id: string): PendingApproval | null;
	deleteById(id: string): void;
	deleteAll(): void;
}

/** Who is deciding: the tapping user, and whether they hold the admin backstop. */
export interface Decider {
	userId: number;
	isAdmin: boolean;
}

/**
 * A decision outcome. `approved` carries the snapshot for the continuation turn;
 * `stale` covers unknown/already-decided/voided ids and expiry — the button
 * answers honestly instead of executing anything (docs/adr/0039).
 */
export type DecideResult =
	| { kind: 'approved'; approval: PendingApproval }
	| { kind: 'denied'; approval: PendingApproval }
	| { kind: 'stale'; reason: 'unknown' | 'expired' }
	| { kind: 'unauthorized' };

export interface ToolApprovalsDeps {
	store: ApprovalStore;
	/** Clock, injected for tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Id factory, injected for tests. Defaults to `crypto.randomUUID()`. */
	newId?: () => string;
}

export class ToolApprovals {
	private readonly store: ApprovalStore;
	private readonly now: () => number;
	private readonly newId: () => string;

	constructor(deps: ToolApprovalsDeps) {
		this.store = deps.store;
		this.now = deps.now ?? Date.now;
		this.newId = deps.newId ?? (() => crypto.randomUUID());
	}

	/**
	 * Persist a pending approval for a gated tool call. Rows are independent —
	 * one turn may request several (docs/adr/0039: a table, not a pinned slot,
	 * so a later request can't silently invalidate an earlier one's buttons).
	 */
	request(toolName: string, args: unknown, requestedBy: number): PendingApproval {
		const createdAt = this.now();
		const row: PendingApproval = {
			id: this.newId(),
			toolName,
			argsJson: JSON.stringify(args ?? {}),
			requestedBy,
			createdAt,
			expiresAt: createdAt + APPROVAL_TTL_MS,
		};
		this.store.insert(row);
		return row;
	}

	/**
	 * Decide a pending approval. Expiry is checked lazily here (no sweeper): an
	 * expired row is dropped and reported `stale`. Only the requester or an admin
	 * may decide. Both decisions consume the row — a second tap answers `stale`.
	 */
	decide(id: string, action: 'approve' | 'deny', decider: Decider): DecideResult {
		const row = this.store.getById(id);
		if (!row) return { kind: 'stale', reason: 'unknown' };
		if (this.now() > row.expiresAt) {
			this.store.deleteById(id);
			return { kind: 'stale', reason: 'expired' };
		}
		if (decider.userId !== row.requestedBy && !decider.isAdmin) return { kind: 'unauthorized' };
		this.store.deleteById(id);
		return action === 'approve' ? { kind: 'approved', approval: row } : { kind: 'denied', approval: row };
	}

	/** Void every pending approval (`/clear`, docs/adr/0039: an approval is an unfinished continuation of the Conversation context). */
	voidAll(): void {
		this.store.deleteAll();
	}

}

// ── Surface: callback codec + renderers ───────────────────────────────────────

/** `callback_data` namespace for approval buttons. */
export const APPROVAL_PREFIX = 'apr';

/** Build an approval `callback_data` (`apr:y:<id>` / `apr:n:<id>`). */
export function approvalCallbackData(id: string, verb: 'approve' | 'deny'): string {
	return `${APPROVAL_PREFIX}:${verb === 'approve' ? 'y' : 'n'}:${id}`;
}

/** Parse an `apr:<verb>:<id>` `callback_data`; `null` when it isn't ours. */
export function parseApprovalCallback(data: string | undefined): { id: string; verb: 'approve' | 'deny' } | null {
	if (!data) return null;
	const parts = data.split(':');
	if (parts[0] !== APPROVAL_PREFIX || parts.length !== 3 || !parts[2]) return null;
	if (parts[1] !== 'y' && parts[1] !== 'n') return null;
	return { id: parts[2], verb: parts[1] === 'y' ? 'approve' : 'deny' };
}

/**
 * One line of human-readable arguments for the request message; JSON as-is
 * when not the `run_shell` shape.
 */
export function describeArgs(argsJson: string): string {
	try {
		const args = JSON.parse(argsJson) as Record<string, unknown>;
		if (typeof args.command === 'string') return args.command;
		return argsJson;
	} catch {
		return argsJson;
	}
}

/** The approval request message + buttons. Plain text — tool args are arbitrary content (the email-arm lesson). */
export function renderApprovalRequest(row: PendingApproval): {
	text: string;
	keyboard: Telegram.InlineKeyboardButton[][];
} {
	return {
		text: `🔐 Approval required: ${row.toolName}\n${describeArgs(row.argsJson)}`,
		keyboard: [
			[
				{ text: '✅ Approve', callback_data: approvalCallbackData(row.id, 'approve') },
				{ text: '✖️ Deny', callback_data: approvalCallbackData(row.id, 'deny') },
			],
		],
	};
}

/**
 * The continuation turn's prompt (docs/adr/0039): the executed snapshot's result,
 * provenance-wrapped (the Scheduled-turn idiom) so the model narrates it and
 * continues, and the Transcript records how its pending call resolved.
 */
export function renderContinuationPrompt(approval: Pick<PendingApproval, 'toolName' | 'argsJson'>, resultJson: string): string {
	return (
		`[approved tool: ${approval.toolName}] input: ${approval.argsJson}\n` +
		`result: ${resultJson}\n` +
		`The user approved this tool call you requested earlier; the result is above. ` +
		`Report the outcome concisely and continue what you were doing.`
	);
}

/**
 * The denial note appended to the **Session** (docs/adr/0039): a user-voiced
 * message (the provenance idiom), so the model sees the denial next turn and
 * doesn't re-propose the action. Costs no inference.
 */
export function renderDenialNote(approval: Pick<PendingApproval, 'toolName' | 'argsJson'>): string {
	return `[tool approval] I denied your ${approval.toolName} request (${describeArgs(approval.argsJson)}). Do not retry it unless I ask.`;
}

/**
 * **Tool approval** decide taps (docs/adr/0039): `apr:y|n:<id>`. No pre-gate —
 * `decideApproval` itself enforces requester-or-admin, so a bystander's tap
 * answers "not yours to decide" without leaking whether the id is live. The
 * request message settles in place (buttons stripped, outcome appended) on any
 * consumed decision, so a stale button can never execute anything.
 */
export const approvalCallbackFamily: CallbackFamily<{ id: string; verb: 'approve' | 'deny' }> = {
	parse: parseApprovalCallback,
	act: async (parsed, ctx) => {
		const agent = await ctx.agent();
		const outcome = await agent.decideApproval(
			parsed.id,
			parsed.verb,
			ctx.callback.from.id,
			ctx.principal.role === 'admin',
			ctx.chatId,
			ctx.message.message_id
		);

		switch (outcome) {
			case 'approved':
				await ctx.settle('✅ Approved — running…');
				return { kind: 'toast', text: '✅ Approved' };
			case 'denied':
				await ctx.settle('✖️ Denied');
				return { kind: 'toast', text: '✖️ Denied' };
			case 'expired':
				await ctx.settle('⌛ Expired');
				return { kind: 'toast', text: 'This request expired.' };
			case 'unauthorized':
				return { kind: 'toast', text: 'Not yours to decide.' };
			case 'stale':
				return { kind: 'toast', text: 'Already handled.' };
		}
	},
};
