import type { SandboxUsageGate } from '../sandbox-usage';

/**
 * Shared seam for the Cloudflare **Sandbox**-backed tools (docs/adr/0019): the
 * injected runner the `run_code` interpreter and the `run_shell` command tool both
 * consume, plus the per-user budget wrapper they share. Structurally a subset of the
 * `@cloudflare/sandbox` stub, so the tools stay testable with a fake — no container.
 */

/** One code-interpreter execution's result — the subset of the SDK `ExecutionResult` we surface. */
export interface SandboxExecutionResult {
	logs: { stdout: string[]; stderr: string[] };
	error?: unknown;
	results: Array<{ text?: string }>;
}

/** One shell command's result — the subset of the SDK `ExecResult` we surface. */
export interface SandboxExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** The languages the Sandbox code interpreter runs (docs/adr/0019); matches the SDK enum. */
export type SandboxLanguage = 'python' | 'javascript' | 'typescript';

/** The code-interpreter surface `run_code` needs — the stub's `runCode`. */
export interface SandboxCodeRunner {
	runCode(code: string, options?: { language?: SandboxLanguage }): Promise<SandboxExecutionResult>;
}

/** The shell surface `run_shell` needs — the stub's `exec`. */
export interface SandboxShellRunner {
	exec(command: string): Promise<SandboxExecResult>;
}

/**
 * The full injected sandbox surface — structurally the `@cloudflare/sandbox` stub.
 * `buildBuiltinTools` holds one of these and hands each tool the narrow slice it uses.
 */
export type SandboxRunner = SandboxCodeRunner & SandboxShellRunner;

/** Wiring shared by the Sandbox-backed tools. */
export interface SandboxToolOptions {
	/** Per-user, per-chat daily budget shared by code and shell; charges failed executions too. */
	usage?: SandboxUsageGate;
	/** Epoch-ms clock for measuring execution time. Defaults to `Date.now`. */
	now?: () => number;
}

/** Friendly tool result returned when the daily sandbox budget is spent. */
export const BUDGET_EXHAUSTED = {
	error:
		'Daily sandbox time limit reached for this chat. The sandbox is rate-limited; ' +
		'try again after the daily reset (00:00 UTC).',
} as const;

/**
 * Run `work` under the per-user budget gate (issue #77): refuse before spending
 * compute when the budget is exhausted, otherwise time the call (wall-clock) and
 * charge it — even on failure, since a crashing run still burned container time.
 * `record` no-ops when the budget is disabled. Shared by `run_code` and `run_shell`.
 */
export async function underBudget<T>(
	usage: SandboxUsageGate | undefined,
	now: () => number,
	work: () => Promise<T>
): Promise<T | typeof BUDGET_EXHAUSTED> {
	if (usage && !usage.allows()) return BUDGET_EXHAUSTED;
	const start = now();
	try {
		return await work();
	} finally {
		usage?.record(Math.max(0, now() - start));
	}
}
