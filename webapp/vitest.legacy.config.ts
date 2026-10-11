import { defineConfig } from 'vitest/config';
import path from 'node:path';
import base from './vitest.config';

export default defineConfig({
	...base,
	test: {
		...base.test,
		include: [path.resolve(__dirname, 'src/miniapp/**/*.test.{ts,tsx}'), path.resolve(__dirname, 'src/shared/**/*.test.{ts,tsx}')],
	},
});
