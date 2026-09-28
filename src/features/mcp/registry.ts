import { drizzle, DrizzleD1Database } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { Env } from '../../core/env';
import { mcpServers } from '../../db/schema';

export { mcpServers } from '../../db/schema';

const mcpSchema = { mcpServers };
export type McpDb = DrizzleD1Database<typeof mcpSchema>;

export function createMcpDb(env: Env): McpDb {
	return drizzle(env.DB, { schema: mcpSchema });
}

export type McpServerRow = typeof mcpServers.$inferSelect;

/**
 * The global MCP server registry (see docs/adr/0008). The source of truth each
 * Conversation Agent reconciles its `this.mcp` against; CRUD'd via `/mcp`.
 */
export const mcpRegistry = {
	list(env: Env): Promise<McpServerRow[]> {
		return createMcpDb(env).select().from(mcpServers).orderBy(mcpServers.name);
	},

	async listEnabled(env: Env): Promise<McpServerRow[]> {
		const rows = await createMcpDb(env).select().from(mcpServers).where(eq(mcpServers.enabled, 1));
		return rows;
	},

	/** Insert or replace a server by its unique name. Returns the stored row. */
	async upsert(
		env: Env,
		input: { name: string; url: string; token?: string }
	): Promise<McpServerRow> {
		const db = createMcpDb(env);
		const values = {
			name: input.name,
			url: input.url,
			enabled: 1,
			authType: input.token ? 'bearer' : 'none',
			authToken: input.token ?? null,
		};
		const [row] = await db
			.insert(mcpServers)
			.values(values)
			.onConflictDoUpdate({ target: mcpServers.name, set: values })
			.returning();
		return row;
	},

	/** Remove a server by name. Returns true if a row was deleted. */
	async remove(env: Env, name: string): Promise<boolean> {
		const deleted = await createMcpDb(env)
			.delete(mcpServers)
			.where(eq(mcpServers.name, name))
			.returning({ id: mcpServers.id });
		return deleted.length > 0;
	},

	/** Toggle a server's enabled flag. Returns true if a row was updated. */
	async setEnabled(env: Env, name: string, enabled: boolean): Promise<boolean> {
		const updated = await createMcpDb(env)
			.update(mcpServers)
			.set({ enabled: enabled ? 1 : 0 })
			.where(eq(mcpServers.name, name))
			.returning({ id: mcpServers.id });
		return updated.length > 0;
	},
};
