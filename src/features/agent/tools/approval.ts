import type { Tool } from 'ai';

/**
 * The gate a gated tool calls instead of executing (docs/adr/0039). The
 * Conversation Agent's implementation persists the pending row *and* sends the
 * approval-request message; the wrapper stays pure and I/O-free.
 */
export interface ApprovalGate {
	request(toolName: string, args: unknown): Promise<{ id: string }>;
}

/**
 * Wrap a **Built-in agent tool** behind the **Tool approval** gate (docs/adr/0039,
 * PRD #98). The wrapped `execute` never runs the tool: it files the argument
 * snapshot with the gate and returns a "pending approval" result the model can
 * relay — approval is a **turn boundary**, and the approved snapshot executes in
 * a later queued turn. Declared statically at tool registration; a per-args
 * predicate can slot into this seam later without a new mechanism.
 */
export function withApproval(toolName: string, gated: Tool, gate: ApprovalGate): Tool {
	return {
		...gated,
		description:
			`${gated.description ?? ''} This tool requires the user's explicit approval: calling it does not run it, ` +
			`but asks the user to approve. Do not call it again while an approval is pending.`.trim(),
		execute: async (args: unknown) => {
			const { id } = await gate.request(toolName, args);
			return {
				pendingApproval: true,
				approvalId: id,
				note: 'Awaiting user approval — the user was shown Approve/Deny buttons. The result will arrive in a later message if approved.',
			};
		},
	} as Tool;
}
