import type { Session, SessionMessage, createCompactFunction } from 'agents/sessions';

/** Stream away image payloads before compaction; Session.compact() hydrates the whole branch. */
export async function compactSessionText(
	session: Session,
	tokenThreshold: number,
	compact: ReturnType<typeof createCompactFunction>,
): Promise<void> {
	try {
		const rows = await session.getHistoryRowStats();
		if (rows.reduce((sum, row) => sum + row.tokenEstimate, 0) <= tokenThreshold) return;
		const history: SessionMessage[] = [];
		let textChars = 0;
		for await (const message of session.history()) {
			const parts = message.parts.filter((part) => part.type === 'text');
			textChars += parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
			history.push({ ...message, parts });
		}
		if (textChars / 4 <= tokenThreshold) return;
		const result = await compact(history);
		if (!result) return;
		// An updated summary includes the previous overlay; keep its original anchor.
		const ids = new Set(history.map((message) => message.id));
		const previous = (await session.getCompactions()).find((entry) => ids.has(`compaction_${entry.id}`));
		await session.addCompaction(result.summary, previous?.fromMessageId ?? result.fromMessageId, result.toMessageId);
	} catch {
		console.warn({ message: 'Session text compaction failed' });
	}
}
