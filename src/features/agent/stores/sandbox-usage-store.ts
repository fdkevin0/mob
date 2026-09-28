import { and, eq, sql } from 'drizzle-orm';
import type { SandboxUsageStore } from '../sandbox-usage';
import { sandboxUsage } from './schema';
import type { StoreDb } from './db';

/** User-scoped UTC-day buckets within this chat’s database. */
export function createSandboxUsageStore(db: StoreDb, userId: number): SandboxUsageStore {
	// Sandbox run-time budget (docs/adr/0019, issue #77): accumulated `run_code`
	// execution ms per Telegram user per UTC day, keyed by `(user_id, day)`. The
	// per-user daily cap on paid container compute — a group chat shares one DO but
	// each member gets their own budget. A new day reads an empty bucket (no reset
	// job).
	return {
		get: (day) => {
			const row = db
				.select()
				.from(sandboxUsage)
				.where(and(eq(sandboxUsage.userId, userId), eq(sandboxUsage.day, day)))
				.get();
			return row?.usedMs ?? 0;
		},
		set: (day, usedMs) => {
			db.insert(sandboxUsage)
				.values({ userId, day, usedMs })
				.onConflictDoUpdate({
					target: [sandboxUsage.userId, sandboxUsage.day],
					set: { usedMs: sql`excluded.used_ms` },
				})
				.run();
		},
	};
}
