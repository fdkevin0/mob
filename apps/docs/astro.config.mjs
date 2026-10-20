// @ts-check
// The documentation site at https://mob.fdkevin.cloud/docs. It builds into the
// public web build (webapp/dist-public/docs), and the Worker in worker/ serves
// it beside the landing page and /app. Pages come from the repository's
// Markdown through scripts/sync.ts; pages.ts lists them in sidebar order.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import inlineScriptHashes from './csp.ts';
import { pages, repositoryUrl } from './pages.ts';

const groups = ['Start', 'Features', 'Reference', 'Contributing'];

export default defineConfig({
	site: 'https://mob.fdkevin.cloud',
	base: '/docs',
	trailingSlash: 'always',
	outDir: '../../webapp/dist-public/docs',
	// Pages share an origin with /app, so they run only scripts this build
	// emits: Astro hashes its scripts and styles into a policy <meta> on each
	// page, and csp.ts adds Starlight's inline scripts. Pagefind search
	// compiles WebAssembly, and code blocks use inline style attributes.
	// worker/index.ts adds the other directives.
	security: {
		csp: {
			scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
			styleDirective: { resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }] },
		},
	},
	integrations: [
		starlight({
			title: 'Mob',
			logo: { src: './src/assets/calf.svg' },
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: repositoryUrl }],
			customCss: ['./src/theme.css'],
			sidebar: groups.map((label) => ({
				label,
				items: pages.filter((page) => page.group === label).map((page) => page.slug === '' ? { label: 'Introduction', link: '/' } : page.slug),
			})),
			plugins: [starlightLinksValidator()],
		}),
		inlineScriptHashes(),
	],
});
