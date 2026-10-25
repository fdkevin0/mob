// Each documentation page asks for its Latin Geist face in <head>, so it
// arrives with the stylesheet instead of after it and the first paint already
// uses it (the web app's pages do the same in webapp/vite.config.ts). Astro
// names the file with a hash, so this runs after the build.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

export default function preloadFonts(): AstroIntegration {
	return {
		name: 'mob:preload-fonts',
		hooks: {
			'astro:build:done': async ({ dir }) => {
				const root = fileURLToPath(dir);
				const font = (await readdir(join(root, '_astro'))).find(file => /^geist-latin-wght-normal\.[\w-]+\.woff2$/.test(file));
				if (!font) throw new Error('no Latin Geist font in the build');
				const link = `<link rel="preload" href="/docs/_astro/${font}" as="font" type="font/woff2" crossorigin>`;
				for (const entry of await readdir(root, { recursive: true })) {
					if (!entry.endsWith('.html')) continue;
					const file = join(root, entry);
					await writeFile(file, (await readFile(file, 'utf8')).replace('</head>', link + '</head>'));
				}
			},
		},
	};
}
