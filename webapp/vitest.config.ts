import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
	root: __dirname,
	resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
	plugins: [react()],
	test: {
		environment: 'happy-dom',
		setupFiles: [path.resolve(__dirname, 'src/test-setup.ts')],
		include: [path.resolve(__dirname, 'src/{chat,landing}/**/*.test.{ts,tsx}')],
	},
});
