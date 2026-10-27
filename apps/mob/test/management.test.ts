import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, Store, ProviderRegistry } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import { Service } from '../src/agents/service';
import { agentPlugin } from '../src/agents';
import { Hub } from '../src/mcp/hub';

test('project forms share service validation and keep multiline checks intact', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mob-project form-'));
	const store = new Store(openBun(':memory:')).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const svc = new Service(store, server, dir);
	server.register(agentPlugin(svc));
	const request = (value?: unknown, auth = token) => server.fetch(new Request('http://localhost/api/plugins/agents/projects', { method: value ? 'POST' : 'GET', body: value ? JSON.stringify(value) : undefined, headers: { Authorization: 'Bearer ' + auth } }));
	try {
		expect((await request({ action: 'add', name: 'demo', path: dir }, 'wrong')).status).toBe(401);
		expect((await request({ action: 'add', name: 'demo', path: 'relative' })).status).toBe(400);
		expect(Bun.spawnSync(['git', 'init', dir]).exitCode).toBe(0);
		expect((await request({ action: 'add', name: 'demo', path: dir })).status).toBe(200);
		for (const name of ['demo', 'renamed', '']) expect((await request({ action: 'add', name, path: dir })).status).toBe(400);
		const other = join(dir, 'other');
		mkdirSync(other);
		expect(Bun.spawnSync(['git', 'init', other]).exitCode).toBe(0);
		expect((await request({ action: 'add', name: 'demo', path: other })).status).toBe(400);
		expect(svc.projects()).toEqual([{ name: 'demo', path: dir }]);
		expect(await svc.addProject(dir, 'demo')).toEqual({ name: 'demo', path: dir });
		const checks = ['echo first\necho second', 'bun test'];
		expect((await request({ action: 'save', name: 'demo', blueprint: 'quick', checks })).status).toBe(200);
		expect(svc.project('demo')).toMatchObject({ path: dir, blueprint: 'quick', checks });
		for (const change of [{ blueprint: 'missing', checks }, { blueprint: 'quick', checks: [1] }, { blueprint: 'quick', checks: [' '] }]) expect((await request({ action: 'save', name: 'demo', ...change })).status).toBe(400);
		expect(svc.project('demo')!.checks).toEqual(checks);
		expect(await (await request()).json()).toMatchObject({ projects: [{ name: 'demo', checks }] });
		expect((await request({ action: 'remove', name: 'demo' })).status).toBe(200);
		expect(svc.projects()).toEqual([]);
		expect(Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree']).exitCode).toBe(0);
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP management exposes status without connection credentials', () => {
	const hub = new Hub();
	hub.configure({ private: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer secret' } } });
	expect(hub.list()).toEqual([{ name: 'private', status: 'not running', tools: [], removable: false }]);
	expect(JSON.stringify(hub.list())).not.toContain('secret');
});
