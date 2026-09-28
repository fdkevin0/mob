import { tool } from 'ai';
import { z } from 'zod';
import { underBudget, type SandboxShellRunner, type SandboxToolOptions } from './sandbox';

/**
 * The **`run_shell`** built-in tool (docs/adr/0019) — runs a bash command in the
 * Cloudflare **Sandbox** via the SDK's `exec()` (distinct from `run_code`'s code
 * interpreter). The model writes a shell command, the sandbox runs it, and
 * stdout/stderr + the exit code feed back into the turn. Same injected-runner shape
 * as `run_code`, sharing the per-user daily budget (issue #77) — one container-time
 * ceiling covers both.
 *
 * Ungated — runs in every chat's turn, like the other built-ins. ⚠️ Shell access is
 * a broader surface than the interpreter (arbitrary commands, package installs,
 * network); it stays inside the per-chat container and under the daily budget.
 */
export function runShellTool(sandbox: SandboxShellRunner, options: SandboxToolOptions = {}) {
	const { usage } = options;
	const now = options.now ?? Date.now;
	return tool({
		description:
			'Run a bash shell command in a secure sandbox and return its output. Use for filesystem operations, ' +
			'installing packages, or running CLI tools. The working directory and installed packages persist across ' +
			'calls in the same chat. Returns stdout, stderr, and the numeric exitCode (non-zero means the command failed).',
		inputSchema: z.object({
			command: z.string().min(1).describe('The bash command to execute'),
		}),
		execute: async ({ command }) =>
			underBudget(usage, now, async () => {
				const result = await sandbox.exec(command);
				return {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				};
			}),
	});
}
