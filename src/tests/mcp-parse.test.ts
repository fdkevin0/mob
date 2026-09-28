import { describe, it, expect } from 'vitest';
import { parseMcpCommand, type McpCommand } from '../features/mcp/parse';

/** Pins the pure `/mcp` argument parser (docs/adr/0008). */
describe('parseMcpCommand', () => {
	function expectAction(cmd: McpCommand, action: McpCommand['action']): void {
		expect(cmd.action).toBe(action);
	}

	it('lists and help actions', () => {
		expectAction(parseMcpCommand(['list']), 'list');
		expectAction(parseMcpCommand([]), 'help');
		expectAction(parseMcpCommand(['help']), 'help');
		expectAction(parseMcpCommand(['LIST']), 'list'); // case-insensitive subcommand
	});

	it('add parses name, url, optional token', () => {
		const cmd = parseMcpCommand(['add', 'github', 'https://mcp.example.com/sse', 'secret123']);
		expect(cmd.action).toBe('add');
		if (cmd.action !== 'add') return;
		expect(cmd.name).toBe('github');
		expect(cmd.url).toBe('https://mcp.example.com/sse');
		expect(cmd.token).toBe('secret123');

		const noToken = parseMcpCommand(['add', 'search', 'https://s.example.com']);
		expect(noToken.action).toBe('add');
		if (noToken.action === 'add') expect(noToken.token).toBeUndefined();
	});

	it('add rejects invalid arguments', () => {
		expectAction(parseMcpCommand(['add']), 'error'); // no name
		expectAction(parseMcpCommand(['add', 'github']), 'error'); // no url
		expectAction(parseMcpCommand(['add', 'github', 'ftp://nope']), 'error'); // bad scheme
		expectAction(parseMcpCommand(['add', 'github', 'not-a-url']), 'error');
	});

	it('on / off / rm parse and reject missing name', () => {
		const on = parseMcpCommand(['on', 'github']);
		expect(on.action).toBe('on');
		if (on.action === 'on') expect(on.name).toBe('github');
		const off = parseMcpCommand(['off', 'github']);
		expect(off.action).toBe('off');
		if (off.action === 'off') expect(off.name).toBe('github');
		const rm = parseMcpCommand(['rm', 'github']);
		expect(rm.action).toBe('rm');
		if (rm.action === 'rm') expect(rm.name).toBe('github');

		expectAction(parseMcpCommand(['rm']), 'error'); // missing name
	});

	it('unknown subcommand is an error', () => {
		expectAction(parseMcpCommand(['frobnicate']), 'error');
	});
});