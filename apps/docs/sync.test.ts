import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pages, type Page } from './pages';
import { convert, rewriteLinks } from './scripts/sync';

const page: Page = { source: 'docs/features/sandbox.md', slug: 'features/sandbox', group: 'Use' };
const github = 'https://github.com/fdkevin0/mob';

describe('rewriteLinks', () => {
	test('turns links between published pages into site routes, keeping fragments and titles', () => {
		expect(rewriteLinks('See [MCP](mcp.md#oauth "MCP servers") and [docs](../README.md).', page)).toBe(
			'See [MCP](/docs/features/mcp/#oauth "MCP servers") and [docs](/docs/).',
		);
	});

	test('points other repository files at GitHub', () => {
		expect(rewriteLinks('[example](../../config.example.yaml) [apps](../../apps)', page)).toBe(
			`[example](${github}/blob/main/config.example.yaml) [apps](${github}/tree/main/apps)`,
		);
	});

	test('rewrites reference definitions and raw HTML', () => {
		expect(rewriteLinks('[mcp]: mcp.md "MCP"', page)).toBe('[mcp]: /docs/features/mcp/ "MCP"');
		expect(rewriteLinks('<a href="skills.md">Skills</a>', page)).toBe('<a href="/docs/features/skills/">Skills</a>');
	});

	test('copies images into the site', () => {
		expect(rewriteLinks('![Runners](../images/remote-runners.png)', page)).toBe('![Runners](/docs/media/docs/images/remote-runners.png)');
		expect(existsSync(join(import.meta.dirname, 'public/media/docs/images/remote-runners.png'))).toBe(true);
	});

	test('keeps code in link text', () => {
		expect(rewriteLinks('[`tool_search`](tools-and-approvals.md#exposure)', page)).toBe('[`tool_search`](/docs/features/tools-and-approvals/#exposure)');
	});

	test('leaves inline code, absolute URLs and anchors alone', () => {
		const line = 'Write `[a](b.md)` like [this](https://example.com) or [here](#top).';
		expect(rewriteLinks(line, page)).toBe(line);
	});

	test('rejects links to missing files', () => {
		expect(() => rewriteLinks('[gone](gone.md)', page)).toThrow('links to missing docs/features/gone.md');
	});
});

describe('convert', () => {
	test('moves the heading into frontmatter and skips fenced code', () => {
		const out = convert('# Sandbox\n\nSee [MCP](mcp.md).\n\n```md\n[MCP](mcp.md)\n```\n', page);
		expect(out).toBe(
			`---\ntitle: "Sandbox"\neditUrl: "${github}/edit/main/docs/features/sandbox.md"\n---\n\nSee [MCP](/docs/features/mcp/).\n\n\`\`\`md\n[MCP](mcp.md)\n\`\`\`\n`,
		);
	});

	test('frames a prototype where the page shows its screenshot', () => {
		const out = convert('# Plans\n\n<!-- prototype: /prototype/plan/?flow=0.build -->\n![The plan as a flow](../images/plan-flow.png)\n', page);
		expect(out).toContain('\n\n<iframe class="prototype" src="/prototype/plan/?flow=0.build" title="The plan as a flow" loading="lazy"></iframe>\n');
		expect(out).not.toContain('plan-flow.png');
		expect(() => convert('# Plans\n\n<!-- prototype: /prototype/plan/ -->\nText\n', page)).toThrow('goes on the line before an image');
		expect(() => convert('# Plans\n\n<!-- prototype: https://example.com/ -->\n![x](../images/plan-flow.png)\n', page)).toThrow('not a prototype');
	});

	test('edits a generated page at its source', () => {
		const reference = pages.find((entry) => entry.source === 'docs/environment-variables.md')!;
		expect(convert('# Keys\n', reference)).toContain(`editUrl: "${github}/edit/main/apps/mob/src/config.ts"`);
	});
});
