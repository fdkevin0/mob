import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { preloadFonts, renderBlocking } from '@mob/ui/vite';
import { workspaceBuild } from '@mob/app/vite';

// The site deployed to Cloudflare Workers (wrangler.jsonc): the landing page,
// the demo page, the account page and the workspace at /app (from @mob/app, in
// public mode, which adds Mob in the browser). The Worker in worker/ serves
// them and sets their content security policies; scripts/build.ts adds the
// documentation under /docs. Files in public/ (the link preview image) are
// copied to the site's root.
export default defineConfig({
	root: import.meta.dirname,
	base: '/',
	mode: 'public',
	publicDir: path.resolve(import.meta.dirname, 'public'),
	plugins: [react(), tailwindcss(), preloadFonts, renderBlocking],
	server: { host: '127.0.0.1', port: 5174, strictPort: true },
	...workspaceBuild,
	build: {
		outDir: path.resolve(import.meta.dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				app: path.resolve(import.meta.dirname, 'app.html'),
				landing: path.resolve(import.meta.dirname, 'landing.html'),
				account: path.resolve(import.meta.dirname, 'account.html'),
				demo: path.resolve(import.meta.dirname, 'demo.html'),
			},
		},
	},
});
