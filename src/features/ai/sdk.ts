/**
 * The project's AI SDK runtime seam. In a Worker, calls are wrapped by the
 * Cloudflare Agents SDK's native tracing integration. The wrapper emits model,
 * token, latency, finish-reason, and tool lifecycle spans while deliberately
 * excluding message bodies and tool arguments/results.
 *
 * The import is lazy because the Worker-side integration imports
 * `cloudflare:workers`, which plain-Node Vitest cannot resolve. Node gets the
 * unwrapped SDK only for that one known runtime mismatch; every other loading
 * error still fails loudly.
 */
import * as ai from 'ai';

let sdkPromise: Promise<typeof ai> | undefined;

function isPlainNodeRuntimeMismatch(error: unknown): boolean {
	return (
		typeof process !== 'undefined' &&
		process.release?.name === 'node' &&
		error instanceof Error &&
		(/Cannot find (?:module|package) ['"]cloudflare:workers['"]/.test(error.message) ||
			/Received protocol ['"]cloudflare:/i.test(error.message))
	);
}

async function loadSdk(): Promise<typeof ai> {
	try {
		const { wrapAISDK } = await import('agents/observability/ai');
		return wrapAISDK(ai, {
			storeMessages: false,
			storeTools: false,
		});
	} catch (error) {
		if (isPlainNodeRuntimeMismatch(error)) return ai;
		throw error;
	}
}

/** Return the tracing-enabled AI SDK namespace (cached after the first call). */
export function getAISDK(): Promise<typeof ai> {
	return (sdkPromise ??= loadSdk());
}

export interface AITraceContext {
	/** Low-cardinality operation name used to group traces. */
	functionId: string;
	/** Opaque conversation/Agent identifier; never a user message or credential. */
	conversationId?: string;
	/** Cloudflare Worker deployment version. */
	agentVersion?: string;
	/** Version of the prompt contract used for this call. */
	promptVersion?: string;
}

/**
 * AI SDK v7 identity metadata for Cloudflare native spans. Only explicitly
 * allowlisted scalar identifiers are emitted. The generic AI SDK telemetry
 * payload switches are also disabled as defense in depth.
 */
export function aiTrace(context: AITraceContext) {
	const runtimeContext = {
		...(context.conversationId ? { conversationId: context.conversationId } : {}),
		...(context.agentVersion ? { agentVersion: context.agentVersion } : {}),
		...(context.promptVersion ? { promptVersion: context.promptVersion } : {}),
	};
	return {
		runtimeContext,
		telemetry: {
			functionId: context.functionId,
			recordInputs: false,
			recordOutputs: false,
			includeRuntimeContext: {
				...(context.conversationId ? { conversationId: true as const } : {}),
				...(context.agentVersion ? { agentVersion: true as const } : {}),
				...(context.promptVersion ? { promptVersion: true as const } : {}),
			},
		},
	};
}
