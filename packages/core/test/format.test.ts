import { expect, test } from 'bun:test';
import { formatDuration, formatMoney, formatSeconds, formatSpeed, formatTokens, modelName, replySpeed } from '../src/format';

test('token counts read short', () => {
	expect([950, 1000, 1234, 12345, 131072, 1e6, 1240000].map(formatTokens)).toEqual(['950', '1k', '1.2k', '12k', '131k', '1M', '1.24M']);
});

test('prices show cents, and a tenth of a cent below a dime', () => {
	expect([0.0042, 0.05, 0.29, 0.5, 12.345].map(formatMoney)).toEqual(['$0.004', '$0.050', '$0.29', '$0.50', '$12.35']);
});

test('durations read to the second or finer', () => {
	expect([45_000, 192_000, 3_900_000, -1].map(formatDuration)).toEqual(['45s', '3m 12s', '1h 5m', '']);
	expect([420, 12_300, 65_000].map(formatSeconds)).toEqual(['0.4s', '12s', '1m 05s']);
});

test('reply speed and model names', () => {
	expect(replySpeed({ generationMs: 7400, timedOutput: 385 })).toBeCloseTo(52.03, 1);
	expect(replySpeed({})).toBeUndefined();
	expect([4.52, 52.03].map(formatSpeed)).toEqual(['4.5 tok/s', '52 tok/s']);
	expect(['anthropic/claude-sonnet-4-5', 'openai/o3:high', 'openrouter/deepseek/deepseek-r1:free', 'codex'].map(modelName))
		.toEqual(['claude-sonnet-4-5', 'o3', 'deepseek/deepseek-r1:free', 'codex']);
});
