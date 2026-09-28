/** Background generation uses the same model, with thinking disabled. */
import { generateText as baseGenerateText, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';
import type { Env } from '../../core/env';
import { DEFAULT_CHAT_MODEL, resolveModel } from './model';
import { aiTrace, getAISDK, type AITraceContext } from './sdk';

type UtilityGenerateResult = Awaited<ReturnType<typeof baseGenerateText>>;

/**
 * Diagnostics a structured-output failure carries on the error itself.
 * `Output.object` throws `NoObjectGeneratedError` with the finish reason,
 * usage, and raw text, which is what distinguishes the three failures that
 * look identical from outside: `length` means the output budget ran out,
 * `stop` with text means the model answered in prose instead of JSON, and
 * `content-filter` means it refused. Empty for any other error type.
 *
 * The response text is reduced to a **length** — never logged — so an email
 * body can't reach the logs through a parse failure (ADR-0051, unpublished).
 */
function structuredOutputFields(error: unknown, result?: UtilityGenerateResult): Record<string, unknown> {
	const source = NoObjectGeneratedError.isInstance(error) ? error : NoOutputGeneratedError.isInstance(error) ? result : undefined;
	if (!source) return {};
	return {
		finishReason: source.finishReason,
		inputTokens: source.usage?.inputTokens,
		outputTokens: source.usage?.outputTokens,
		reasoningTokens: source.usage?.outputTokenDetails?.reasoningTokens,
		responseTextLength: source.text?.length,
	};
}

/** The `generateText` arguments a utility call may pass — everything but the model. */
export type UtilityGenerateArgs = Omit<Parameters<typeof baseGenerateText>[0], 'model'>;

export async function generateUtility(
	env: Env,
	args: UtilityGenerateArgs,
	trace: Pick<AITraceContext, 'functionId' | 'conversationId' | 'promptVersion'> = {
		functionId: 'conversation-agent.utility',
	},
): Promise<UtilityGenerateResult> {
	const resolved = resolveModel(env, 'off');
	const { generateText } = await getAISDK();
	let result: UtilityGenerateResult | undefined;
	try {
		result = await generateText({
			...args,
			...resolved,
			maxRetries: 0,
			...aiTrace({ ...trace, agentVersion: env.CF_VERSION_METADATA?.id }),
		} as Parameters<typeof baseGenerateText>[0]);
		// The SDK's structured-output getter may throw after generation resolves.
		if (args.output != null) void result.output;
		return result;
	} catch (error) {
		console.error({ message: 'Utility generation failed', feature: 'ai', model: DEFAULT_CHAT_MODEL, ...structuredOutputFields(error, result) });
		throw error;
	}
}
