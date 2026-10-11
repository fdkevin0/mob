import { describe, it, expect } from 'vitest';
import { buildBuiltinTools, builtinToolLabels } from '../features/agent/tools';
import { datetimeTool } from '../features/agent/tools/datetime';
import { fetchUrlTool } from '../features/agent/tools/fetch-url';
import { webSearchTool } from '../features/agent/tools/web-search';
import { weatherTool } from '../features/agent/tools/weather';
import { Memory } from '../features/memory/memory';
import type { Env } from '../core/env';

/** Invoke an AI-SDK tool's execute with a minimal options bag. */
async function run(tool: any, args: unknown): Promise<any> {
	return tool.execute(args, { toolCallId: 't', messages: [] });
}

const FIXED = new Date('2026-06-20T13:30:00.000Z');

/** A Response whose content-type and text we control. */
function response(contentType: string, body: string): Response {
	return new Response(body, { headers: { 'content-type': contentType } });
}

/** A JSON Response (status configurable) for fake-`fetch` tool tests. */
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Minimal non-tool deps for `buildBuiltinTools` in gating tests. */
function fakeBuiltinDeps() {
	const memory = new Memory({
		chatId: 1,
		store: { insert() {}, update() {}, listIds: () => [], listAll: () => [], getByIds: () => [], deleteByIds() {}, deleteAll() {} },
		index: { async upsert() {}, async query() { return []; }, async deleteByIds() {} },
		embed: async () => [0],
	});
	const sandbox = {
		runCode: async () => ({ logs: { stdout: [], stderr: [] }, results: [] }),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
	};
	return { memory, sandbox, now: () => FIXED };
}

/**
 * Tests the built-in tools (PRD #72, docs/adr/0015) through the
 * `buildBuiltinTools` factory and the individual tool factories, injecting a fixed
 * clock, a fake `fetch`, and a fake `env.AI` — no network, no Workers AI, no DO.
 */
describe('builtinToolLabels', () => {
	it('web_search labels with the query (or empty when missing)', () => {
		expect(builtinToolLabels.web_search({ query: 'cats' })).toBe('cats');
		expect(builtinToolLabels.web_search({})).toBe('');
	});

	it('fetch_url labels with the hostname only (or empty when unparseable)', () => {
		expect(builtinToolLabels.fetch_url({ url: 'https://example.com/docs?x=1' })).toBe('example.com');
		expect(builtinToolLabels.fetch_url({ url: 'not a url' })).toBe('');
	});

	it('run_code labels with the language (or empty when missing)', () => {
		expect(builtinToolLabels.run_code({ language: 'python', code: 'print(1)' })).toBe('python');
		expect(builtinToolLabels.run_code({ code: 'print(1)' })).toBe('');
	});
});

describe('run_code tool', () => {
	it('joins stdout and surfaces a text result; no error key on success', async () => {
		const { runCodeTool } = await import('../features/agent/tools/run-code');
		const ok = runCodeTool({
			runCode: async () => ({ logs: { stdout: ['4', '\n'], stderr: [] }, results: [{ text: '4' }] }),
		});
		const out = await run(ok, { code: 'print(2+2)', language: 'python' });
		expect(out.stdout).toBe('4\n');
		expect(Array.isArray(out.results) && out.results[0] === '4').toBe(true);
		expect('error' in out).toBe(false);
	});

	it('joins stderr and stringifies an ExecutionError value; no results key when empty', async () => {
		const { runCodeTool } = await import('../features/agent/tools/run-code');
		const bad = runCodeTool({
			runCode: async () => ({ logs: { stdout: [], stderr: ['Traceback…'] }, error: { name: 'NameError', value: "name 'x' is not defined" }, results: [] }),
		});
		const errOut = await run(bad, { code: 'print(x)' });
		expect(errOut.stderr).toBe('Traceback…');
		expect(errOut.error).toBe("name 'x' is not defined");
		expect('results' in errOut).toBe(false);
	});

	it('threads the model-chosen language to the runner', async () => {
		const { runCodeTool } = await import('../features/agent/tools/run-code');
		let seenLang: string | undefined;
		const t = runCodeTool({
			runCode: async (_code, opts) => {
				seenLang = opts?.language;
				return { logs: { stdout: ['hi\n'], stderr: [] }, results: [] };
			},
		});
		const out = await run(t, { code: 'console.log("hi")', language: 'javascript' });
		expect(seenLang).toBe('javascript');
		expect(out.stdout).toBe('hi\n');
	});

	it('never runs the runner when over budget; returns a limit notice', async () => {
		const { runCodeTool } = await import('../features/agent/tools/run-code');
		let ranWhenBlocked = false;
		const blocked = runCodeTool(
			{ runCode: async () => { ranWhenBlocked = true; return { logs: { stdout: [], stderr: [] }, results: [] }; } },
			{ usage: { allows: () => false, record: () => {} } }
		);
		const blockedOut = await run(blocked, { code: 'print(1)' });
		expect(ranWhenBlocked).toBe(false);
		expect(typeof blockedOut.error === 'string' && /limit/i.test(blockedOut.error)).toBe(true);
	});

	it('records the wall-clock ms on a successful run when under budget', async () => {
		const { runCodeTool } = await import('../features/agent/tools/run-code');
		let recorded = -1;
		let clock = 1000;
		const allowed = runCodeTool(
			{ runCode: async () => ({ logs: { stdout: ['ok'], stderr: [] }, results: [] }) },
			{ usage: { allows: () => true, record: (ms) => { recorded = ms; } }, now: () => clock += 250 }
		);
		const out = await run(allowed, { code: 'print(1)' });
		expect(out.stdout).toBe('ok');
		// now() ticks +250 on the start read and again on the finally read → 250ms elapsed.
		expect(recorded).toBe(250);
	});
});

describe('run_shell tool', () => {
	it('passes the command through and maps the result; surfaces exitCode + stderr plainly on failure', async () => {
		const { runShellTool } = await import('../features/agent/tools/run-shell');

		let seenCommand = '';
		const ok = runShellTool({
			exec: async (command) => {
				seenCommand = command;
				return { stdout: 'file.txt\n', stderr: '', exitCode: 0 };
			},
		});
		const out = await run(ok, { command: 'ls' });
		expect(seenCommand).toBe('ls');
		expect(out.stdout).toBe('file.txt\n');
		expect(out.stderr).toBe('');
		expect(out.exitCode).toBe(0);

		// Non-zero exit is surfaced plainly via exitCode + stderr (no synthesized error).
		const fail = runShellTool({ exec: async () => ({ stdout: '', stderr: 'nope: not found', exitCode: 127 }) });
		const failOut = await run(fail, { command: 'nope' });
		expect(failOut.exitCode).toBe(127);
		expect(failOut.stderr).toBe('nope: not found');
		expect('error' in failOut).toBe(false);
	});

	it('never runs exec when over budget; returns a limit notice', async () => {
		const { runShellTool } = await import('../features/agent/tools/run-shell');
		let ranWhenBlocked = false;
		const blocked = runShellTool(
			{ exec: async () => { ranWhenBlocked = true; return { stdout: '', stderr: '', exitCode: 0 }; } },
			{ usage: { allows: () => false, record: () => {} } }
		);
		const blockedOut = await run(blocked, { command: 'ls' });
		expect(ranWhenBlocked).toBe(false);
		expect(typeof blockedOut.error === 'string' && /limit/i.test(blockedOut.error)).toBe(true);
	});

	it('records the wall-clock ms of a successful run when under budget', async () => {
		const { runShellTool } = await import('../features/agent/tools/run-shell');
		let recorded = -1;
		let clock = 0;
		const allowed = runShellTool(
			{ exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
			{ usage: { allows: () => true, record: (ms) => { recorded = ms; } }, now: () => (clock += 250) }
		);
		const out = await run(allowed, { command: 'echo ok' });
		expect(out.stdout).toBe('ok');
		expect(recorded).toBe(250);
	});
});

describe('datetime tool', () => {
	it('uses the requested timezone and reports UTC iso + localized readable time', async () => {
		const t = datetimeTool({ now: () => FIXED, defaultTimezone: 'UTC' });
		const out = await run(t, { timezone: 'Asia/Shanghai' });
		expect(out.iso).toBe('2026-06-20T13:30:00.000Z');
		expect(out.timezone).toBe('Asia/Shanghai');
		// 13:30 UTC is 21:30 in Shanghai (UTC+8).
		expect(/9:30|21:30/.test(out.readable)).toBe(true);
	});

	it('defaults to the bot timezone when none requested; iso stays UTC', async () => {
		const t = datetimeTool({ now: () => FIXED, defaultTimezone: 'Europe/London' });
		const out = await run(t, {});
		expect(out.timezone).toBe('Europe/London');
		expect(out.iso).toBe('2026-06-20T13:30:00.000Z');
	});

	it('falls back to UTC for an invalid timezone', async () => {
		const t = datetimeTool({ now: () => FIXED, defaultTimezone: 'UTC' });
		const out = await run(t, { timezone: 'Not/AZone' });
		expect(out.timezone).toBe('UTC');
	});
});

describe('fetch_url tool', () => {
	it('passes a markdown content-type through without calling toMarkdown', async () => {
		let toMarkdownCalled = false;
		const ai = { toMarkdown: async () => { toMarkdownCalled = true; return [{ data: 'should not run' }]; } };
		const fakeFetch = (async () => response('text/markdown; charset=utf-8', '# Native Markdown')) as unknown as typeof fetch;

		const t = fetchUrlTool({ fetch: fakeFetch, ai: ai as any });
		const out = await run(t, { url: 'https://example.com' });

		expect(out.markdown).toBe('# Native Markdown');
		expect(toMarkdownCalled).toBe(false);
	});

	it('uses turndown by default for non-markdown HTML', async () => {
		let toMarkdownCalled = false;
		const ai = { toMarkdown: async () => { toMarkdownCalled = true; return [{ data: 'should not run' }]; } };
		const fakeFetch = (async () => response('text/html', '<h1>Page</h1>')) as unknown as typeof fetch;

		const t = fetchUrlTool({ fetch: fakeFetch, ai: ai as any });
		const out = await run(t, { url: 'https://example.com' });

		// `turndown` converts <h1>Page</h1> → "# Page\n\n"
		expect(out.markdown.startsWith('# Page')).toBe(true);
		expect(toMarkdownCalled).toBe(false);
	});

	it('uses env.AI.toMarkdown when parser is "ai", passing the fetched HTML', async () => {
		let seenHtml = '';
		const ai = {
			toMarkdown: async (files: Array<{ blob: Blob }>) => {
				seenHtml = await files[0].blob.text();
				return [{ data: '# Converted' }];
			},
		};
		const fakeFetch = (async () => response('text/html', '<h1>Page</h1>')) as unknown as typeof fetch;

		const t = fetchUrlTool({ fetch: fakeFetch, ai: ai as any, parser: 'ai' });
		const out = await run(t, { url: 'https://example.com' });

		expect(out.markdown).toBe('# Converted');
		expect(seenHtml).toBe('<h1>Page</h1>');
	});
});

describe('web_search tool', () => {
	it('maps and caps to 5 results, dropping raw_content', async () => {
		// Tavily returns 6 hits with extra fields; the tool maps and caps to 5.
		const raw = Array.from({ length: 6 }, (_, i) => ({
			title: `t${i}`,
			url: `https://e/${i}`,
			content: `c${i}`,
			score: 1 - i / 10,
			raw_content: 'should be dropped',
		}));
		const fakeFetch = (async () => json({ results: raw })) as unknown as typeof fetch;
		const t = webSearchTool({ fetch: fakeFetch, apiKey: 'tvly-x' });
		const out = await run(t, { query: 'cats' });
		expect(out.results.length).toBe(5);
		expect(out.results[0].title).toBe('t0');
		expect(out.results[0].url).toBe('https://e/0');
		expect('raw_content' in out.results[0]).toBe(false);
	});

	it('sends the bearer key + query to the Tavily endpoint', async () => {
		let seenUrl = '';
		let seenAuth = '';
		let seenBody: any = {};
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seenUrl = url;
			seenAuth = (init.headers as Record<string, string>).Authorization;
			seenBody = JSON.parse(init.body as string);
			return json({ results: [] });
		}) as unknown as typeof fetch;
		const t = webSearchTool({ fetch: fakeFetch, apiKey: 'tvly-secret' });
		await run(t, { query: 'weather in paris' });
		expect(seenUrl).toBe('https://api.tavily.com/search');
		expect(seenAuth).toBe('Bearer tvly-secret');
		expect(seenBody.query).toBe('weather in paris');
		expect(seenBody.search_depth === 'basic' && seenBody.max_results === 5).toBe(true);
	});

	it('throws on a non-200 Tavily response, mentioning the status', async () => {
		const fakeFetch = (async () => json({ error: 'rate limited' }, 429)) as unknown as typeof fetch;
		const t = webSearchTool({ fetch: fakeFetch, apiKey: 'tvly-x' });
		await expect(run(t, { query: 'x' })).rejects.toThrow(/429/);
	});

	it('is gated out of buildBuiltinTools when TAVILY_API_KEY is missing, present when it is set', async () => {
		const deps = fakeBuiltinDeps();
		const withoutKey = buildBuiltinTools({ AI: { toMarkdown: async () => [{ data: '' }] } } as unknown as Env, deps);
		expect('web_search' in withoutKey).toBe(false);
		const withKey = buildBuiltinTools(
			{ AI: { toMarkdown: async () => [{ data: '' }] }, TAVILY_API_KEY: 'tvly-x' } as unknown as Env,
			deps
		);
		expect('web_search' in withKey).toBe(true);
	});
});

describe('weather tool', () => {
	it('geocodes a city name then fetches the forecast', async () => {
		const calls: string[] = [];
		const fakeFetch = (async (url: string) => {
			calls.push(url);
			if (url.includes('geocoding-api')) {
				return json({ results: [{ name: 'Paris', country_code: 'FR', latitude: 48.85, longitude: 2.35 }] });
			}
			return json({
				timezone: 'Europe/Paris',
				current: { temperature_2m: 29.1, relative_humidity_2m: 50, apparent_temperature: 30, weather_code: 3, wind_speed_10m: 4.2, precipitation: 0 },
				daily: { time: ['2026-06-25'], weather_code: [3], temperature_2m_max: [40], temperature_2m_min: [27.7], precipitation_probability_max: [10] },
			});
		}) as unknown as typeof fetch;
		const t = weatherTool({ fetch: fakeFetch });
		const out = await run(t, { location: 'Paris' });
		expect(calls.length).toBe(2);
		expect(out.location).toBe('Paris, FR');
		expect(out.current.condition).toBe('Overcast');
		expect(out.daily[0].condition === 'Overcast' && out.daily[0].temperature_max === 40).toBe(true);
	});

	it('skips geocoding when coords are provided', async () => {
		const calls: string[] = [];
		const fakeFetch = (async (url: string) => {
			calls.push(url);
			return json({
				timezone: 'UTC',
				current: { temperature_2m: 10, relative_humidity_2m: 80, apparent_temperature: 9, weather_code: 0, wind_speed_10m: 1, precipitation: 0 },
				daily: { time: ['2026-06-25'], weather_code: [0], temperature_2m_max: [12], temperature_2m_min: [5], precipitation_probability_max: [0] },
			});
		}) as unknown as typeof fetch;
		const t = weatherTool({ fetch: fakeFetch });
		const out = await run(t, { location: 'Somewhere', latitude: 0, longitude: 0 });
		expect(calls.length).toBe(1);
		expect(!calls[0].includes('geocoding-api')).toBe(true);
		expect(out.current.condition).toBe('Clear sky');
	});

	it('returns a soft error for an unknown city; forecast is not run', async () => {
		let forecastCalled = false;
		const fakeFetch = (async (url: string) => {
			if (url.includes('geocoding-api')) return json({});
			forecastCalled = true;
			return json({});
		}) as unknown as typeof fetch;
		const t = weatherTool({ fetch: fakeFetch });
		const out = await run(t, { location: 'Xyzzqq' });
		expect(typeof out.error === 'string' && /Xyzzqq/.test(out.error)).toBe(true);
		expect(forecastCalled).toBe(false);
	});
});

describe('buildBuiltinTools', () => {
	it('omits Long-term Memory tools when no scoped Memory dependency is supplied', () => {
		const deps = fakeBuiltinDeps();
		const { memory: _memory, ...withoutMemory } = deps;
		const tools = buildBuiltinTools(
			{ AI: { toMarkdown: async () => [{ data: '' }] } } as unknown as Env,
			withoutMemory
		);
		expect('remember' in tools).toBe(false);
		expect('recall' in tools).toBe(false);
	});

	it('assembles the expected toolset (no web_search without TAVILY_API_KEY)', async () => {
		const env = { AI: { toMarkdown: async () => [{ data: '' }] }, BOT_TIMEZONE: 'UTC' } as unknown as Env;
		const memory = new Memory({
			chatId: 1,
			store: { insert() {}, update() {}, listIds: () => [], listAll: () => [], getByIds: () => [], deleteByIds() {}, deleteAll() {} },
			index: { async upsert() {}, async query() { return []; }, async deleteByIds() {} },
			embed: async () => [0],
		});


		const sandbox = {
			runCode: async () => ({ logs: { stdout: [], stderr: [] }, results: [] }),
			exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		};

		// No TAVILY_API_KEY on this env → `web_search` is gated out; `get_weather` is always present.
		const tools = buildBuiltinTools(env, { memory, sandbox, now: () => FIXED });
		const names = Object.keys(tools).sort();
		expect(names.join(',')).toBe(
			'fetch_url,get_date_time,get_weather,recall,remember,run_code,run_shell'
		);
	});
});
