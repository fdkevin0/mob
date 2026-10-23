// Delegated conversations: an outside agent, such as a coding agent working
// on a task, writes the replies. Its approvals are the permissions it asks for.
import type { Usage as LLMUsage } from '../llm/llm';
import { addLLMUsage } from './engine';
import type { Event } from './events';
import { Aborted, isAbort } from './running';
import { newID } from './sql';
import type { Decision, Message, Part, Store } from './store';

/** Answer is the user's decision on a pending approval. A denial may say why, and the model then answers it. */
export type Answer = { id: string; approved: boolean; reason?: string; remember?: string };

/**
 * Delegate runs the turns of conversations an outside agent answers. The
 * agent keeps waiting while an approval is pending; the turn that asked ends,
 * and the owner's decision starts the turn that follows the agent on.
 */
export interface Delegate {
	owns(conversationID: string): boolean;
	/** label names the agent; replies record it as their model. */
	label(conversationID: string): string;
	/** reply streams the agent's work into turn until the agent finishes or waits for an approval. */
	reply(turn: DelegateTurn, signal: AbortSignal): Promise<void>;
	/** decide passes the owner's answer on d, already recorded, to the agent waiting for it. */
	decide(conversationID: string, d: Decision, a: Answer): void | Promise<void>;
}

/** DelegateTurn is one reply of a delegated conversation as the delegate writes it. */
export class DelegateTurn {
	private segments = new Map<string, { index: number; id: string }>();
	private stepped = false;
	constructor(readonly conversationId: string,
		/** text is what the owner wrote; empty when the turn follows an approval. */
		readonly text: string, readonly channel: string,
		private store: Store, private message: Message, private send: (e: Event) => Promise<void>) {}

	get messageId() { return this.message.id; }
	/** wrote reports whether the reply shows anything yet. */
	wrote() { return this.message.parts.length > 0; }
	/** conclusion is the reply's last text, which usually sums up the turn. */
	conclusion() {
		for (let i = this.message.parts.length - 1; i >= 0; i--) if (this.message.parts[i].type === 'text') return String(this.message.parts[i].text ?? '');
		return '';
	}

	private async step() {
		if (this.stepped) return;
		this.stepped = true;
		await this.send({ kind: 'step-started' });
	}

	/** stream adds delta to the reply's current text or reasoning. */
	async stream(kind: 'text' | 'reasoning', delta: string) {
		if (!delta) return;
		await this.step();
		let s = this.segments.get(kind);
		if (!s) {
			s = { index: this.message.parts.length, id: newID() };
			this.segments.set(kind, s);
			this.message.parts.push({ type: kind, text: '' });
			await this.send({ kind: 'segment-started', segment: kind, id: s.id });
		}
		this.message.parts[s.index].text += delta;
		await this.send({ kind: 'segment-delta', segment: kind, id: s.id, text: delta });
	}

	/** endStep finishes the open text and reasoning, so what follows starts new parts after them. */
	async endStep() {
		if (!this.stepped) return;
		for (const kind of ['reasoning', 'text'] as const) {
			const s = this.segments.get(kind);
			if (s) await this.send({ kind: 'segment-finished', segment: kind, id: s.id });
		}
		this.segments.clear();
		this.stepped = false;
		await this.send({ kind: 'step-finished' });
	}

	/** used records what the agent's session used for the reply; model names the model, or the agent when it did not say which. */
	async used(session: string, model: string, u: LLMUsage, tookMs: number) {
		this.message.usage = addLLMUsage(this.message.usage, u);
		this.store.recordUsage(this.conversationId, this.message.id, model, u, tookMs, session);
		await this.send({ kind: 'usage', usage: u });
	}

	hasTool(id: string) { return !!this.part(id); }
	private part(id: string): Part | undefined { return this.message.parts.find(p => p.toolCallId === id); }

	/** tool shows a call the agent makes. */
	async tool(id: string, name: string, input: unknown) {
		if (this.hasTool(id)) return;
		await this.endStep();
		await this.step();
		this.message.parts.push({ type: 'tool-' + name, toolCallId: id, state: 'input-available', input });
		await this.send({ kind: 'tool-input', toolCallId: id, toolName: name, input });
	}

	/** toolDone records how a call shown with tool ended; a call the reply does not show is ignored. */
	async toolDone(id: string, output: unknown, failure: string) {
		const part = this.part(id);
		if (!part || part.state === 'output-available' || part.state === 'output-error') return;
		if (failure) {
			part.state = 'output-error';
			part.errorText = failure;
			await this.send({ kind: 'tool-failed', toolCallId: id, error: failure });
			return;
		}
		part.state = 'output-available';
		part.output = output;
		await this.send({ kind: 'tool-output', toolCallId: id, output });
	}

	/** requestApproval asks the owner to approve call id, shown with tool, and returns the approval's ID. */
	async requestApproval(id: string, input: unknown): Promise<string> {
		const part = this.part(id);
		if (!part) throw new Error('approval requested for a call the reply does not show');
		part.input = input;
		const approval = this.store.requestApproval(this.conversationId, this.message, id, input);
		await this.send({ kind: 'approval-requested', approvalId: approval, toolCallId: id, toolName: String(part.type).slice('tool-'.length), input });
		return approval;
	}
}

/** runDelegate is run for a delegated conversation: the delegate writes the reply, which is saved while it streams and once it ends. */
export async function runDelegate(signal: AbortSignal, store: Store, delegate: Delegate, input: { id: string; text: string; channel?: string }, message: Message, emit: (e: Event) => void | Promise<void>) {
	let lastSave = Date.now();
	const send = async (e: Event) => {
		if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Aborted();
		if (Date.now() - lastSave > 1000) { store.save(message, 'streaming', ''); lastSave = Date.now(); }
		await emit(e);
	};
	const turn = new DelegateTurn(input.id, input.text, input.channel ?? '', store, message, send);
	let runErr: Error | undefined;
	try {
		await send({ kind: 'turn-started', messageId: message.id });
		await delegate.reply(turn, signal);
		await turn.endStep();
	} catch (e) {
		runErr = e instanceof Error ? e : new Error(String(e));
	}
	const status = !runErr ? 'complete' : isAbort(runErr) || signal.aborted ? 'cancelled' : 'error';
	store.save(message, status, runErr?.message ?? '');
	if (runErr) throw runErr;
}
