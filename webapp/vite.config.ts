import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The public mode builds the site deployed to Cloudflare Workers (wrangler.jsonc):
// the landing page plus the web UI. The Worker in worker/ serves both and sets
// their content security policies.
export default defineConfig(({ mode }) => ({
	root: path.resolve(__dirname),
	base: '/',
	resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
	publicDir: false,
	plugins: [react(), tailwindcss(), mode === 'public' ? null : {
		name: 'go-embed-placeholder',
		generateBundle() { this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '\n' }); },
	}],
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
	build: {
		outDir: path.resolve(__dirname, mode === 'public' ? 'dist-public' : 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				chat: path.resolve(__dirname, 'index.html'),
				...(mode === 'public' ? { landing: path.resolve(__dirname, 'landing.html') } : {}),
			},
		},
	},
}));
