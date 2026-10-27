import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	test: {
		environment: 'happy-dom',
		setupFiles: [path.resolve(import.meta.dirname, 'src/test-setup.ts')],
		include: ['src/**/*.test.{ts,tsx}'],
	},
});
