import { eq } from 'drizzle-orm';
import type { ReplyState } from '../../email/email-reply';
import { emailReply } from './schema';
import type { StoreDb } from './db';

const map = ({ id: _id, ...state }: typeof emailReply.$inferSelect): ReplyState => ({
	...state,
	status: state.status === 'drafted' ? 'drafted' : 'armed',
});

/** The pinned-row port over `email_reply` (docs/adr/0013): the **EmailReply module**'s single armed slot. */
export interface EmailReplyStore {
	get(): ReplyState | null;
	save(state: ReplyState): void;
	clear(): void;
}

/** @see conversation-agent.ts `emailReplyStore` */
export function createEmailReplyStore(db: StoreDb): EmailReplyStore {
	// At most one reply is armed per chat at a time (docs/adr/0009): a single
	// pinned row (id=1), replaced on each new refer, cleared on send/cancel.
	return {
		get: () => {
			const row = db.select().from(emailReply).where(eq(emailReply.id, 1)).get();
			return row ? map(row) : null;
		},
		save: (state) => {
			const values = { id: 1, ...state };
			db.insert(emailReply)
				.values(values)
				.onConflictDoUpdate({
					target: emailReply.id,
					set: values,
				})
				.run();
		},
		clear: () => {
			db.delete(emailReply).run();
		},
	};
}
