import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export default defineConfig({
	root: path.resolve(__dirname),
	base: '/',
 publicDir: false,
	plugins: [react(), tailwindcss(), {
		name: 'go-embed-placeholder',
		generateBundle() { this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '\n' }); },
	}],
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
	define: {
		'import.meta.env.VITE_APP_VERSION': JSON.stringify(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim()),
		'import.meta.env.VITE_BUILD_DATE': JSON.stringify(new Date().toUTCString()),
	},
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
