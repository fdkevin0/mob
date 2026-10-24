import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The public mode builds the site deployed to Cloudflare Workers (wrangler.jsonc):
// the landing page, the demo page, the account page and the web UI. The Worker in worker/ serves both and sets
// their content security policies. Its files in public/ (the link preview image)
// are copied to the site's root; the embedded app has none.
export default defineConfig(({ mode }) => ({
	root: path.resolve(__dirname),
	base: '/',
	resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
	publicDir: mode === 'public' ? path.resolve(__dirname, 'public') : false,
	plugins: [react(), tailwindcss()],
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
