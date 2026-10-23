// An MCP server for tests: over stdio, or as a web handler.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export function testServer() {
	const s = new McpServer({ name: 'test', version: '1' });
	s.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
	s.registerTool('env', { description: 'Show the environment' }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ secret: process.env.MOB_SECRET ?? '', extra: process.env.EXTRA ?? '' }) }] }));
	s.registerTool('fail', { description: 'Fail' }, async () => ({ isError: true, content: [{ type: 'text', text: 'it failed' }] }));
	return s;
}

if (import.meta.main) await testServer().connect(new StdioServerTransport());
