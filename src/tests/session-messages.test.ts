import { describe, it, expect } from 'vitest';
import { userMessage, assistantMessage, historyToModelMessages } from '../features/ai/session-messages';

/**
 * Tests the **Session API** message seam (docs/adr/0017): that the UIMessages a
 * turn appends round-trip through the real `ai` `convertToModelMessages` into the
 * `ModelMessage[]` `streamText` expects — no Durable Object, no Session instance.
 * This is the foundation the live turn-loop rewiring builds on.
 */
describe('userMessage / assistantMessage builders', () => {
	it('build a UIMessage with the right role, id, and a single text part', () => {
		const u = userMessage('hello', 'u1');
		expect(u.role).toBe('user');
		expect(u.id).toBe('u1');
		expect(u.parts.length).toBe(1);
		expect(u.parts[0].type).toBe('text');
		expect((u.parts[0] as { text: string }).text).toBe('hello');

		const a = assistantMessage('hi there', 'a1');
		expect(a.role).toBe('assistant');
		expect((a.parts[0] as { text: string }).text).toBe('hi there');
	});

	it('generate distinct ids by default; an explicit id is honoured', () => {
		expect(userMessage('x').id).not.toBe(userMessage('x').id);
		expect(assistantMessage('x', 'fixed').id).toBe('fixed');
	});
});

describe('historyToModelMessages', () => {
	it('converts a UIMessage history to ModelMessage[] preserving roles and text', async () => {
		const history = [userMessage('what is 2+2?', 'u1'), assistantMessage('4', 'a1'), userMessage('thanks', 'u2')];
		const model = await historyToModelMessages(history);

		// One model message per stored turn, roles preserved in order, no system message
		// injected (the system prompt is supplied separately to streamText).
		expect(model.length).toBe(3);
		expect(model.map((m) => m.role).join(',')).toBe('user,assistant,user');
		expect(model.some((m) => m.role === 'system')).toBe(false);
		// The text survives the round-trip (content may be a string or a parts array).
		expect(JSON.stringify(model[0])).toContain('what is 2+2?');
		expect(JSON.stringify(model[1])).toContain('4');
	});

	it('an empty history → no model messages', async () => {
		expect((await historyToModelMessages([])).length).toBe(0);
	});
});