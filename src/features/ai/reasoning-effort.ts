/** Thinking controls supported by DeepSeek Chat Completions. */
export type ReasoningEffort = 'default' | 'off' | 'low' | 'high' | 'max';

const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = ['default', 'off', 'low', 'high', 'max'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === 'string' && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}
