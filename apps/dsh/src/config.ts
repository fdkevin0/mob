import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from '@deepseek-ai/cordis';

export interface LoadedPlugin {
	name: string;
	plugin: Plugin;
	config?: unknown;
}

// Resolve installed packages and local modules beside the configuration file.
export async function loadPlugins(filename: string): Promise<LoadedPlugin[]> {
	const file = resolve(filename);
	const entries: unknown = JSON.parse(await readFile(file, 'utf8'));
	if (!Array.isArray(entries)) throw new Error('DSH configuration must be an array of { module, config? }');
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== 'object' ||
			Array.isArray(entry) ||
			typeof entry.module !== 'string' ||
			!entry.module.trim() ||
			Object.keys(entry).some((key) => key !== 'module' && key !== 'config')
		) {
			throw new Error('Each DSH plugin needs module and optional config; no other fields are supported');
		}
	}
	const require = createRequire(pathToFileURL(file));
	const plugins: LoadedPlugin[] = [];
	for (const entry of entries) {
		const module = await import(pathToFileURL(require.resolve(entry.module)).href);
		plugins.push({ name: entry.module, plugin: module.default ?? module, config: entry.config });
	}
	return plugins;
}
