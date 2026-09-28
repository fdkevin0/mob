import { describe, it, expect } from 'vitest';
import { getGlobalConfig, setEmailHtmlParser } from '../features/ai/global-config';

/** In-memory stand-in for `STATE` KV. */
function fakeKV(): KVNamespace & { raw: Map<string, string> } {
	const raw = new Map<string, string>();
	const kv = {
		raw,
		get: async (key: string, type?: string) => {
			const value = raw.get(key);
			if (value === undefined) return null;
			return type === 'json' ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => {
			raw.set(key, value);
		},
		delete: async (key: string) => {
			raw.delete(key);
		},
	};
	return kv as unknown as KVNamespace & { raw: Map<string, string> };
}

describe('email conversion config', () => {
	it('defaults to local conversion', async () => {
		expect(await getGlobalConfig(fakeKV())).toEqual({ emailHtmlParser: 'turndown' });
	});
	it('discards model slots when saving the remaining setting', async () => {
		const kv = fakeKV();
		kv.raw.set('ai:global-config', JSON.stringify({ defaultModels: { chat: 'old:model' }, fallbackReasoningEffort: 'high' }));
		await setEmailHtmlParser(kv, 'ai');
		expect(await getGlobalConfig(kv)).toEqual({ emailHtmlParser: 'ai' });
		expect(JSON.parse(kv.raw.get('ai:global-config')!)).toEqual({ emailHtmlParser: 'ai' });
	});
	it('rejects invalid parsers', async () => {
		await expect(setEmailHtmlParser(fakeKV(), 'gfm' as never)).rejects.toThrow();
	});
});
