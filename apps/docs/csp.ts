// Astro hashes the scripts it bundles into each page's policy <meta>, but not
// the `is:inline` scripts Starlight writes (theme, sidebar, search shortcut).
// After the build this adds a hash of every inline script on a page to that
// page's script-src, so they run and nothing else inline does.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

const policyMeta = /(<meta http-equiv="content-security-policy" content="[^"]*?script-src )([^;"]*)/;
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

export function hashInlineScripts(html: string): string {
	const meta = html.match(policyMeta);
	if (!meta) throw new Error('page has no content security policy with script-src');
	const sources = new Set(meta[2].split(' '));
	for (const [, body] of html.matchAll(inlineScript)) {
		sources.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
	}
	return html.replace(policyMeta, (_, start: string) => start + [...sources].join(' '));
}

export default function inlineScriptHashes(): AstroIntegration {
	return {
		name: 'mob:inline-script-hashes',
		hooks: {
			'astro:build:done': async ({ dir }) => {
				const root = fileURLToPath(dir);
				for (const entry of await readdir(root, { recursive: true })) {
					if (!entry.endsWith('.html')) continue;
					const file = join(root, entry);
					await writeFile(file, hashInlineScripts(await readFile(file, 'utf8')));
				}
			},
		},
	};
}
