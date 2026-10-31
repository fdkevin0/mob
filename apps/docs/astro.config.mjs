// @ts-check
// The documentation site at https://usemob.app/docs. The site's build
// (apps/web/scripts/build.ts) copies dist/ to /docs, and its Worker serves it
// beside the landing page and /app. Pages come from the repository's
// Markdown through scripts/sync.ts; pages.ts lists them in sidebar order.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import inlineScriptHashes from './csp.ts';
import preloadFonts from './fonts.ts';
import { groups, pages, repositoryUrl } from './pages.ts';


export default defineConfig({
	site: 'https://usemob.app',
	base: '/docs',
	trailingSlash: 'always',
	// Pages share an origin with /app, so they run only scripts this build
	// emits: Astro hashes its scripts and styles into a policy <meta> on each
	// page, and csp.ts adds Starlight's inline scripts. Pagefind search
	// compiles WebAssembly, and code blocks use inline style attributes.
	// apps/web/worker/index.ts adds the other directives.
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
			// The header and theme picker match the rest of the site.
			components: {
				Header: './src/components/Header.astro',
				MobileMenuFooter: './src/components/MobileMenuFooter.astro',
				PageTitle: './src/components/PageTitle.astro',
				Sidebar: './src/components/Sidebar.astro',
				MobileTableOfContents: './src/components/MobileTableOfContents.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			expressiveCode: { styleOverrides: { borderRadius: '12px' } },
			// Starlight sets the other Open Graph and Twitter tags; links to the
			// docs preview with the landing page's image (apps/web/public/og.png).
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://usemob.app/og.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: "Agents for you: calves at work in Mob's voxel office" } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://usemob.app/og.png' } },
			],
			sidebar: groups.map((label) => ({
				label,
				items: pages.filter((page) => page.group === label).map((page) => page.slug === '' ? { label: 'Introduction', link: '/' } : page.slug),
			})),
			plugins: [starlightLinksValidator()],
		}),
		inlineScriptHashes(),
		preloadFonts(),
	],
});
