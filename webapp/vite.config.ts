import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
	root: path.resolve(__dirname),
	base: '/',
 publicDir: false,
	plugins: [react(), tailwindcss(), {
		name: 'go-embed-placeholder',
		generateBundle() { this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '\n' }); },
	}],
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
	build: {
		outDir: path.resolve(__dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				chat: path.resolve(__dirname, 'index.html'),
			},
		},
	},
});
