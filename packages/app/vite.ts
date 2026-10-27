import type { UserConfig } from 'vite';

// What every build that includes the workspace needs: this package's own and
// the site's (apps/web).
export const workspaceBuild = {
	// sqlite-wasm finds its .wasm next to its own module, which prebundling would move.
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	// The browser runner's worker is served from /runner/, where the site's Worker gives it its own policy.
	worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'runner/[name]-[hash].js' } } },
} satisfies UserConfig;
