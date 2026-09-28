import { tool } from 'ai';
import { z } from 'zod';

/**
 * The launcher the **`deep_task`** tool hands the model's request to
 * (docs/adr/0040). The Conversation Agent's implementation claims the single
 * slot, sends the `🔬 … [✖️ Cancel]` start message, and starts the fiber; a soft
 * `{ error }` (slot busy) comes back for the model to relay.
 */
export interface DeepTaskLauncher {
	launch(input: { description: string; prompt: string }): Promise<{ started: true } | { error: string }>;
}

/**
 * The **`deep_task`** built-in tool (docs/adr/0040, PRD #99): move a job too big
 * for the front turn (5 steps) to a background run with its own budget (20
 * steps / 15 min). Registered only for `schedule_turns` holders — the same
 * trust tier as **Scheduled turns** (open-ended model spend).
 */
export function deepTaskTool(launcher: DeepTaskLauncher) {
	return tool({
		description:
			'Run a long task in the background (research across sources, multi-step analysis, report writing) when the ' +
			'job clearly needs more tool calls than a normal reply allows. The task runs on its own budget (up to 20 ' +
			'tool steps, 15 minutes) and posts its report to this chat when done. Only one deep task can run at a time. ' +
			'Do not use it for anything you can answer directly in this turn.',
		inputSchema: z.object({
			description: z.string().min(1).max(120).describe('A short human-readable label for the task, shown in the chat'),
			prompt: z
				.string()
				.min(1)
				.describe('The full self-contained task instructions, including what the final report should contain'),
		}),
		execute: async (input) => {
			const result = await launcher.launch(input);
			return 'error' in result
				? result
				: { started: true, note: 'The task now runs in the background; its report will arrive as a separate message.' };
		},
	});
}
