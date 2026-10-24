// Change says what a write changed, so a client reloads only that: a
// conversation (its messages, model or whether a turn runs), the conversation
// list (a title, order or new conversation), or the task tree.
export type Change = { seq: number; conversation?: string; list?: boolean; tasks?: boolean };

// Changes tells subscribers about store writes as they happen. It holds no
// history: a client reloads what it shows whenever it (re)subscribes.
export class Changes {
	private seq = 0;
	private subs = new Set<(c: Change) => void>();

	/** subscribe calls listen with each change from now on and returns the function that ends it. */
	subscribe(listen: (c: Change) => void): () => void {
		this.subs.add(listen);
		return () => { this.subs.delete(listen); };
	}

	/** watched reports whether anyone subscribes, so writes skip finding out what they changed when no one would hear. */
	watched() { return this.subs.size > 0; }

	publish(change: Omit<Change, 'seq'>) {
		const c = { ...change, seq: ++this.seq };
		for (const listen of [...this.subs]) {
			try { listen(c); } catch { this.subs.delete(listen); }
		}
	}

	/** conversation publishes a change to conversation id; list also when the conversation list changed. */
	conversation(id: string, list: boolean) {
		if (!id) return;
		const c: Omit<Change, 'seq'> = { conversation: id };
		if (list) c.list = true;
		this.publish(c);
	}

	tasks() { this.publish({ tasks: true }); }
}
