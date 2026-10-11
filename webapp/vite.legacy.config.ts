import { defineConfig, mergeConfig } from 'vite';
import path from 'node:path';
import modern from './vite.config';

export default defineConfig(mergeConfig(modern, {
 publicDir: path.resolve(__dirname, 'public'),
 build: { outDir: path.resolve(__dirname, 'dist-legacy'), rollupOptions: { input: path.resolve(__dirname, 'miniapp/index.html') } },
}));
