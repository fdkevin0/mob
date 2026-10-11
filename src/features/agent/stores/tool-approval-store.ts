import { eq } from 'drizzle-orm';
import type { ApprovalStore } from '../tool-approvals';
import { pendingApprovals } from './schema';
import type { StoreDb } from './db';

export function createToolApprovalStore(db: StoreDb): ApprovalStore {
	// Tool approvals (docs/adr/0039): pending argument snapshots awaiting a human
	// decision — a table, not a pinned slot (one turn may request several). Rows
	// are consumed on decide, dropped lazily on expiry, voided by /clear.
	return {
		insert: (values) => {
			db.insert(pendingApprovals).values(values).onConflictDoUpdate({
				target: pendingApprovals.id,
				set: values,
			}).run();
		},
		getById: (id) => db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get() ?? null,
		deleteById: (id) => {
			db.delete(pendingApprovals).where(eq(pendingApprovals.id, id)).run();
		},
		deleteAll: () => {
			db.delete(pendingApprovals).run();
		},
	};
}
