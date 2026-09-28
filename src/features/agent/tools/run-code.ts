import { tool } from 'ai';
import { z } from 'zod';
import { underBudget, type SandboxCodeRunner, type SandboxToolOptions } from './sandbox';

/**
 * The **`run_code`** built-in tool (docs/adr/0019) — a code interpreter backed by
 * the Cloudflare **Sandbox** (`@cloudflare/sandbox`, a container DO). The model
 * writes Python, JavaScript, or TypeScript, the sandbox runs it, and stdout/stderr
 * text feeds back into the turn. Mirrors the **Memory tool** pair (docs/adr/0015):
 * a thin AI-SDK wrapper over an injected runner, so it is testable with a fake and
 * the call lands in the Debug trace.
 *
 * Ungated — runs in every chat's turn, like the other built-ins. ⚠️ This exposes
 * paid container execution to anyone who can message the bot (docs/adr/0019),
 * bounded by the shared per-user daily budget (issue #77).
 */

/** Render an SDK `ExecutionError` (or any thrown value) to a short string. */
function stringifyExecError(error: unknown): string {
	if (error && typeof error === 'object') {
		const e = error as { name?: string; value?: string; message?: string };
		return e.value ?? e.message ?? `${e.name ?? 'Error'}`;
	}
	return typeof error === 'string' ? error : String(error);
}

export function runCodeTool(sandbox: SandboxCodeRunner, options: SandboxToolOptions = {}) {
	const { usage } = options;
	const now = options.now ?? Date.now;
	return tool({
		description:
			'Execute Python, JavaScript, or TypeScript code in a secure sandbox and return its output. Use for ' +
			'calculations, data processing, parsing, or checking a snippet. Files and variables persist across calls ' +
			'in the same chat (per language). Returns stdout/stderr text; print/console.log what you want to see.',
		inputSchema: z.object({
			code: z.string().min(1).describe('Source code to execute'),
			language: z
				.enum(['python', 'javascript', 'typescript'])
				.default('python')
				.describe('Language to run the code as. Defaults to python.'),
		}),
		execute: async ({ code, language }) =>
			underBudget(usage, now, async () => {
				const result = await sandbox.runCode(code, { language });
				const stdout = result.logs.stdout.join('');
				const stderr = result.logs.stderr.join('');
				// Rich-display results (e.g. a final expression's repr) — keep only text.
				const results = result.results.flatMap((r) => (r.text ? [r.text] : []));
				return {
					stdout,
					stderr,
					...(result.error ? { error: stringifyExecError(result.error) } : {}),
					...(results.length ? { results } : {}),
				};
			}),
	});
}
