import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../utils/hmac';

describe('sha256Hex', () => {
	it('is deterministic and distinguishes inputs', async () => {
		const first = await sha256Hex('token-a');
		expect(await sha256Hex('token-a')).toBe(first);
		expect(await sha256Hex('token-b')).not.toBe(first);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
	});
});
