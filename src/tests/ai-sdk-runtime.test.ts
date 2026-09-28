import { describe, expect, it } from 'vitest';
import { aiTrace, getAISDK } from '../features/ai/sdk';

describe('AI SDK runtime seam', () => {
	it('loads the raw SDK under plain Node where cloudflare:workers is unavailable', async () => {
		const sdk = await getAISDK();
		expect(typeof sdk.generateText).toBe('function');
		expect(typeof sdk.streamText).toBe('function');
	});

	it('allowlists only opaque scalar identity and disables payload recording', () => {
		const options = aiTrace({
			functionId: 'conversation-agent.chat',
			conversationId: 'opaque-do-id',
			agentVersion: 'worker-version',
			promptVersion: 'chat-test.1',
		});

		expect(options).toEqual({
			runtimeContext: {
				conversationId: 'opaque-do-id',
				agentVersion: 'worker-version',
				promptVersion: 'chat-test.1',
			},
			telemetry: {
				functionId: 'conversation-agent.chat',
				recordInputs: false,
				recordOutputs: false,
				includeRuntimeContext: {
					conversationId: true,
					agentVersion: true,
					promptVersion: true,
				},
			},
		});
	});
});
