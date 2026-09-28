import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Env } from '../../core/env';
import type { ReasoningEffort } from './reasoning-effort';

/** One native-vision model for chat, deep tasks, and utility calls. */
export const DEFAULT_CHAT_MODEL = 'deepseek-flash';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * The app's shared `off` reasoning value becomes `reasoning_effort: "none"`
 * before it reaches a generic OpenAI-compatible provider. DeepSeek's Chat
 * Completions API disables thinking with `thinking.type` instead, and accepts
 * only low/high/max in `reasoning_effort`. Translate just that sentinel while
 * leaving the SDK-built request object and supported efforts untouched.
 */
export function transformDeepSeekRequestBody(body: Record<string, unknown>): Record<string, unknown> {
	if (body.reasoning_effort !== 'none') return body;
	const transformed = { ...body };
	delete transformed.reasoning_effort;
	transformed.thinking = { type: 'disabled' };
	return transformed;
}

/** Construct the one built-in hosted provider through its official endpoint. */
export function createDeepSeekProvider(apiKey: string) {
	return createOpenAICompatible({
		name: 'deepseek',
		baseURL: DEEPSEEK_BASE_URL,
		apiKey,
		transformRequestBody: transformDeepSeekRequestBody,
	});
}

/** Response length cap, preserving the previous Workers AI `max_tokens: 1024`. */
export const MAX_RESPONSE_TOKENS = 1024;

/**
 * Cap for the agentic chat turn. Higher than the triage default because hosted
 * models' reasoning tokens count against the limit; 2048 leaves headroom while
 * keeping replies chat-sized.
 *
 * Load-bearing invariant: this cap is also what keeps a finalized **Streaming
 * reply** under Telegram's `RICH_MESSAGE_CHAR_LIMIT` (32768) — at worst-case ~4
 * chars/token, 2048 tokens ≈ 8192 chars, 4× under the ceiling — so no outbound
 * length guard is needed (PRD #75, CONTEXT.md). If you raise this, the tripwire
 * in `reply-surface.test.ts` will fail once worst-case output could touch the
 * ceiling; revisit the Rich Message limit there before bumping it.
 */
export const MAX_CHAT_TOKENS = 2048;

/** Construct the shared model with per-call thinking controls. */
export function resolveModel(env: Env, effort: ReasoningEffort = 'default'): {
	model: LanguageModel;
	providerOptions?: Record<string, Record<string, string>>;
} {
	return {
		model: env.CHAT_MODEL ?? createDeepSeekProvider(env.DEEPSEEK_API_KEY).chatModel(DEFAULT_CHAT_MODEL),
		providerOptions: effort === 'default' ? undefined : { deepseek: { reasoningEffort: effort === 'off' ? 'none' : effort } },
	};
}
