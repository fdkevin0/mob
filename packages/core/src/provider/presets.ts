// Vendors Mob knows how to reach: adding one needs only a key.

/** Quirk adapts one vendor's requests after the driver builds them. */
export type Quirk = (model: string, headers: Headers, body: Record<string, unknown>) => void;

export type Preset = {
	id: string;
	name: string;
	chat?: string;
	anthropic?: string;
	/** catalog names its models.dev entry. */
	catalog?: string;
	keysUrl?: string;
	/** noKey marks local servers, where a key is optional. */
	noKey?: boolean;
	/** publicKey is sent when the user saved none (OpenCode Zen's free tier). */
	publicKey?: string;
	/** appKey is sent when the user saved none, to a local gateway that tells apps apart by it (magpie). */
	appKey?: string;
	/** default is the model a new installation starts on. */
	default?: string;
	quirk?: Quirk;
};

/** magpieKey names Mob to the magpie gateway, which counts the calls as Mob's. */
export const magpieKey = 'magpie-mob';
export const magpiePort = 3425;

// openCodeVersion is the client release version accepted by OpenCode Zen's gateway.
const openCodeVersion = '1.18.34';
const openCodeFreeIDs = new Set(['big-pickle', 'grok-code']);
export const openCodeFree = (model: string) => model.endsWith('-free') || openCodeFreeIDs.has(model);

const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// sessionSeed is sha256("global"), which OpenCode's CLI identifiers derive from.
let session = '';
async function openCodeSession() {
	if (!session) session = openCodeIDFrom('ses', new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global'))));
	return session;
}
void openCodeSession();

function openCodeIDFrom(prefix: string, b: Uint8Array) {
	let id = prefix + '_' + hex(b.subarray(0, 6));
	for (const c of b.subarray(6, 20)) id += base62[c % base62.length];
	return id;
}

const randomID = (prefix: string) => openCodeIDFrom(prefix, crypto.getRandomValues(new Uint8Array(32)));

/**
 * openCode presents requests as the OpenCode CLI does. Its free tier also
 * rejects requests whose tools lack the CLI's bash and read, so inert stubs
 * are declared when missing.
 */
const openCode: Quirk = (model, h, body) => {
	h.set('User-Agent', 'opencode/' + openCodeVersion);
	h.set('x-opencode-client', 'cli');
	h.set('x-opencode-project', 'global');
	h.set('x-opencode-session', session || randomID('ses'));
	h.set('x-opencode-request', randomID('msg'));
	if (!openCodeFree(model)) return;
	const tools = (body.tools as { function?: { name?: string } }[] | undefined) ?? [];
	const have = new Set(tools.map(t => t.function?.name));
	for (const name of ['bash', 'read']) {
		if (!have.has(name)) tools.push({ type: 'function', function: { name, description: 'Not available in this session. Never call this tool.', parameters: { type: 'object', properties: {} } } } as never);
	}
	body.tools = tools;
};

/** presets are ordered as `mob provider add --help` lists them. */
export const presets: Preset[] = [
	{ id: 'opencode', name: 'OpenCode Zen', chat: 'https://opencode.ai/zen/v1', catalog: 'opencode', keysUrl: 'https://opencode.ai/auth', publicKey: 'public', default: 'mimo-v2.6-flash-free', quirk: openCode },
	{ id: 'openai', name: 'OpenAI', chat: 'https://api.openai.com/v1', catalog: 'openai', keysUrl: 'https://platform.openai.com/api-keys' },
	{ id: 'anthropic', name: 'Anthropic', anthropic: 'https://api.anthropic.com', catalog: 'anthropic', keysUrl: 'https://console.anthropic.com/settings/keys' },
	{ id: 'deepseek', name: 'DeepSeek', chat: 'https://api.deepseek.com/v1', anthropic: 'https://api.deepseek.com/anthropic', catalog: 'deepseek', keysUrl: 'https://platform.deepseek.com/api_keys' },
	{ id: 'google', name: 'Google Gemini', chat: 'https://generativelanguage.googleapis.com/v1beta/openai', catalog: 'google', keysUrl: 'https://aistudio.google.com/apikey' },
	{ id: 'openrouter', name: 'OpenRouter', chat: 'https://openrouter.ai/api/v1', catalog: 'openrouter', keysUrl: 'https://openrouter.ai/keys' },
	{ id: 'moonshot', name: 'Kimi', chat: 'https://api.moonshot.ai/v1', anthropic: 'https://api.moonshot.ai/anthropic', catalog: 'moonshotai', keysUrl: 'https://platform.moonshot.ai/console/api-keys' },
	{ id: 'zhipu', name: 'Zhipu GLM', chat: 'https://open.bigmodel.cn/api/paas/v4', catalog: 'zhipuai', keysUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
	{ id: 'ollama', name: 'Ollama', chat: 'http://localhost:11434/v1', noKey: true },
	{ id: 'lmstudio', name: 'LM Studio', chat: 'http://localhost:1234/v1', noKey: true },
	// The address is magpie's default; `mob provider add magpie` finds the port magpie is set to.
	{ id: 'magpie', name: 'Magpie', chat: `http://127.0.0.1:${magpiePort}/v1`, anthropic: `http://127.0.0.1:${magpiePort}`, noKey: true, appKey: magpieKey },
];

export const findPreset = (id?: string) => (id ? presets.find(p => p.id === id) : undefined);

/** publicPreset is a preset as the API lists it. */
export const publicPreset = ({ quirk: _q, publicKey: _p, appKey: _a, default: _d, ...rest }: Preset) => rest;
