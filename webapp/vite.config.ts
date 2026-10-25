import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The public mode builds the site deployed to Cloudflare Workers (wrangler.jsonc):
// the landing page, the demo page, the account page and the web UI. The Worker in worker/ serves both and sets
// their content security policies. Its files in public/ (the link preview image)
// are copied to the site's root; the embedded app has none.
// Each page asks for its Latin Geist face in <head>, so they arrive with the
// stylesheet instead of after it and the first paint already uses them.
const preloadFonts: Plugin = {
	name: 'mob:preload-fonts',
	apply: 'build',
	transformIndexHtml: {
		order: 'post',
		handler: (_html, { bundle }) => Object.keys(bundle ?? {})
			.filter(file => /\/geist-latin-wght-normal-[\w-]+\.woff2$/.test(file))
			.map(file => ({ tag: 'link', attrs: { rel: 'preload', href: '/' + file, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' as const })),
	},
};

// Vite rewrites a page's entry script and drops blocking="render" on the way;
// this puts it back on the built tag for each page whose source asks for it.
const renderBlocking: Plugin = {
	name: 'mob:render-blocking',
	apply: 'build',
	transformIndexHtml: {
		order: 'post',
		handler: (html, { filename }) => readFileSync(filename, 'utf8').includes('blocking="render"')
			? html.replace(/<script type="module" crossorigin src=/, '<script type="module" blocking="render" crossorigin src=')
			: html,
	},
};

export default defineConfig(({ mode }) => ({
	root: path.resolve(__dirname),
	base: '/',
	resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
	publicDir: mode === 'public' ? path.resolve(__dirname, 'public') : false,
	plugins: [react(), tailwindcss(), preloadFonts, renderBlocking],
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
	// sqlite-wasm finds its .wasm next to its own module, which prebundling would move.
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	// The browser runner's worker is served from /runner/, where the Worker gives it its own policy.
	worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'runner/[name]-[hash].js' } } },
	build: {
		outDir: path.resolve(__dirname, mode === 'public' ? 'dist-public' : 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				chat: path.resolve(__dirname, 'index.html'),
				...(mode === 'public' ? { landing: path.resolve(__dirname, 'landing.html'), account: path.resolve(__dirname, 'account.html'), demo: path.resolve(__dirname, 'demo.html') } : {}),
			},
		},
	},
}));
