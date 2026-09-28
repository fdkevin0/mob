import type { HtmlParserKind } from './types';

export type { HtmlParserKind } from './types';

export interface GlobalConfig {
	emailHtmlParser: HtmlParserKind;
}

const GLOBAL_CONFIG_KV_KEY = 'ai:global-config';

export async function getGlobalConfig(kv: KVNamespace): Promise<GlobalConfig> {
	const stored = await kv.get<GlobalConfig>(GLOBAL_CONFIG_KV_KEY, 'json');
	return { emailHtmlParser: stored?.emailHtmlParser === 'ai' ? 'ai' : 'turndown' };
}

export async function setEmailHtmlParser(kv: KVNamespace, parser: HtmlParserKind): Promise<GlobalConfig> {
	if (parser !== 'turndown' && parser !== 'ai') throw new Error(`invalid html parser: ${parser}`);
	const next = { emailHtmlParser: parser };
	await kv.put(GLOBAL_CONFIG_KV_KEY, JSON.stringify(next));
	return next;
}
