import { defineConfig } from 'vitest/config';

// The web packages' suites (bun run test:web). Each keeps its own config.
export default defineConfig({
	test: { projects: ['packages/ui', 'packages/app', 'apps/web'] },
});
