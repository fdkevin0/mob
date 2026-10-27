import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { preloadFonts } from '@mob/ui/vite';
import { workspaceBuild } from './vite.ts';

// The workspace as mob serves it from loopback (apps/mob embeds dist/) and the
// desktop app loads it. The site builds the same entry in apps/web.
export default defineConfig({
	root: import.meta.dirname,
	base: '/',
	publicDir: false,
	plugins: [react(), tailwindcss(), preloadFonts],
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
	...workspaceBuild,
	build: {
		outDir: path.resolve(import.meta.dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: { input: { app: path.resolve(import.meta.dirname, 'index.html') } },
	},
});
