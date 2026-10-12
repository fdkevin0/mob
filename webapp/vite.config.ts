import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The public mode builds the web UI deployed to Cloudflare Workers (wrangler.jsonc).
// Its content security policy lets the page reach only Mob on this computer,
// not even its own site, so the token cannot be sent anywhere else.
const publicHeaders = `/*
  Content-Security-Policy: default-src 'self'; connect-src http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`;

export default defineConfig(({ mode }) => ({
	root: path.resolve(__dirname),
	base: '/',
	publicDir: false,
	plugins: [react(), tailwindcss(), mode === 'public' ? {
		name: 'workers-headers',
		generateBundle() { this.emitFile({ type: 'asset', fileName: '_headers', source: publicHeaders }); },
	} : {
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
			},
		},
	},
}));
