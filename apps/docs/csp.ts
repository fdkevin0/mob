// Astro hashes the scripts it bundles into each page's policy <meta>, but not
// the `is:inline` scripts Starlight writes (theme, sidebar, search shortcut).
// After the build this adds a hash of every inline script on a page to that
// page's script-src, so they run and nothing else inline does. A <meta>
// policy governs only what follows it, so it also moves the policy to the top
// of <head>, ahead of Starlight's first inline script.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

const policyMeta = /<meta http-equiv="content-security-policy" content="([^"]*)">/;
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const headStart = /<head>(<meta charset="[^"]*"\/?>)?/;

export function hashInlineScripts(html: string): string {
	const meta = html.match(policyMeta);
	const scriptSrc = meta?.[1].match(/script-src ([^;]*)/);
	if (!meta || !scriptSrc) throw new Error('page has no content security policy with script-src');
	const sources = new Set(scriptSrc[1].split(' '));
	for (const [, body] of html.matchAll(inlineScript)) {
		sources.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
	}
	const policy = meta[1].replace(scriptSrc[0], `script-src ${[...sources].join(' ')}`);
	const rest = html.replace(meta[0], '');
	if (!headStart.test(rest)) throw new Error('page has no <head>');
	return rest.replace(headStart, (start) => `${start}<meta http-equiv="content-security-policy" content="${policy}">`);
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
