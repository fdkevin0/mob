import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Worker-side test suite (replaces the ts-node runner, docs/adr/0044). `root:
// __dirname` keeps this config's behavior independent of the cwd it's invoked
// from — `pnpm test` runs `vitest run` from the repo root, while the SPA's own
// `webapp/vitest.config.ts` runs separately (different environment, different
// include). `environment: 'node'` — these suites drive pure-function seams and
// fakes (no DOM, no Workers runtime); Node 18+ supplies `ReadableStream`,
// `TextEncoder`, `Headers`, `crypto` for the few suites needing them. The
// `webapp/**` exclude keeps the SPA's tests under their own config.
export default defineConfig({
	root: __dirname,
	resolve: {
		alias: { '../../assets/tools': path.resolve(__dirname, 'src/tests/fixtures/asset-tools.ts') },
	},
	test: {
		environment: 'node',
		include: [path.resolve(__dirname, 'src/**/*.test.{ts,tsx}')],
		exclude: [
			'node_modules/**',
			'**/node_modules/**',
			'webapp/**',
			// The following suites depend on private/unextracted Telegram/db modules left as reference:
			'src/tests/email-triage.test.ts',
			'src/tests/outbound-queue.test.ts',
			'src/tests/quote.test.ts',
			'src/tests/read-tools.test.ts',
			'src/tests/reply-surface.test.ts',
			'src/tests/turn-driver.test.ts',
		],
	},
});
