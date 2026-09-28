import { tool } from 'ai';
import { z } from 'zod';
import type { ScheduledTurns, ScheduledTurnView } from '../scheduled-turns';

/**
 * The **Scheduled turn** tool trio (docs/adr/0028): `schedule_turn` /
 * `list_scheduled` / `cancel_scheduled`, the conversational surface over the
 * `ScheduledTurns` core. One verb per tool (the `remember`/`recall` idiom).
 * Guardrail violations come back as soft `{ error }`s so the model relays them.
 * Admin-only: `buildBuiltinTools` registers the trio only when handed a
 * `scheduledTurns` dep — the model never sees a tool it cannot use.
 */

/** The `when` input: exactly one of `at` / `recurrence` (validated by the core). */
const whenSchema = z.object({
	at: z.string().optional().describe('One-off: a future ISO 8601 datetime, e.g. "2026-07-03T09:00:00Z"'),
	recurrence: z
		.string()
		.optional()
		.describe('Recurring: a 5-field cron expression evaluated in local time, e.g. "0 8 * * 1-5" for weekday mornings'),
	timezone: z
		.string()
		.optional()
		.describe('IANA timezone the recurrence is evaluated in, e.g. "Europe/London". Defaults to the bot timezone.'),
});

export function scheduleTurnTool(turns: ScheduledTurns) {
	return tool({
		description:
			'Schedule a prompt to run as a future conversation turn — a reminder, a recurring briefing, or any future action. ' +
			'The prompt runs with full tool access at fire time. Pass exactly one of when.at (one-off) or when.recurrence (recurring). ' +
			'Recurring turns must be at least 15 minutes apart; at most 10 tasks may be active.',
		inputSchema: z.object({
			prompt: z.string().describe('The prompt to run at fire time, as if the user had typed it'),
			description: z.string().describe('A short human label for the task, e.g. "morning briefing"'),
			when: whenSchema,
		}),
		execute: async ({ prompt, description, when }) => {
			const result = await turns.create({ prompt, description, when });
			if ('error' in result) return result;
			return {
				scheduled: true,
				id: result.task.id,
				description: result.task.description,
				next: result.next.toISOString(),
				...(result.task.when.kind === 'recurring'
					? { recurrence: result.task.when.cron, timezone: result.task.when.timezone }
					: {}),
			};
		},
	});
}

export function listScheduledTool(turns: ScheduledTurns) {
	return tool({
		description: 'List the scheduled turns for this chat: id, description, next fire time, recurrence, and any last error.',
		inputSchema: z.object({}),
		execute: async () => ({ tasks: turns.list().map(viewToResult) }),
	});
}

export function cancelScheduledTool(turns: ScheduledTurns) {
	return tool({
		description: 'Cancel a scheduled turn by id (find ids with list_scheduled).',
		inputSchema: z.object({ id: z.string().describe('The task id to cancel') }),
		execute: async ({ id }) => {
			const cancelled = await turns.cancel(id);
			return cancelled ? { cancelled: true } : { error: `No scheduled turn with id ${id}. Use list_scheduled to see ids.` };
		},
	});
}

/** Flatten a view for the model: ISO next fire, the `when` fields inline. */
function viewToResult(view: ScheduledTurnView) {
	return {
		id: view.id,
		description: view.description,
		prompt: view.prompt,
		status: view.status,
		next: view.next?.toISOString() ?? null,
		...(view.when.kind === 'recurring' ? { recurrence: view.when.cron, timezone: view.when.timezone } : {}),
		...(view.lastError ? { lastError: view.lastError } : {}),
	};
}
