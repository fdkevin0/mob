// providers.json on disk: owner-only, replaced atomically with a backup,
// and changed under a lock the service and the CLI both take.
import { lstatSync, readFileSync } from 'node:fs';
import { Catalog, type CatalogData, type ProvidersFile, type ProvidersStorage } from '@mob/core';
import { join } from 'node:path';
import { windows, withLock, writeAtomic } from './files';
import { cacheHome } from './paths';
import { homedir } from 'node:os';

const maxFile = 1 << 20;

/** Unreadable is a providers.json that exists but cannot be used; it is never taken for an empty list. */
export class Unreadable extends Error {
	constructor(reason: string) { super('providers.json is unreadable: ' + reason); }
}

export function readProviders(path: string): ProvidersFile | undefined {
	let info;
	try { info = lstatSync(path); } catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw new Unreadable((e as Error).message);
	}
	if (!info.isFile() || info.size > maxFile) throw new Unreadable('must be a regular file of at most 1 MiB');
	if (!windows && info.mode & 0o077) throw new Unreadable(`it holds API keys and must be owner-only (chmod 600 ${path})`);
	try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Unreadable('invalid JSON or unknown field'); }
}

export function fileProviders(path: string): ProvidersStorage {
	return {
		read: () => readProviders(path),
		update: change => withLock(path + '.lock', () => {
			const f = change(readProviders(path));
			writeAtomic(path, JSON.stringify(f, null, 2) + '\n', true);
			return f;
		}),
	};
}

/** catalogPath is Mob's copy of the models.dev catalog; OpenCode's is read when it is missing. */
export const catalogPath = () => join(cacheHome(), 'mob', 'models.json');
const fallbacks = () => [join(homedir(), '.cache', 'opencode', 'models.json')];

export function fileCatalog() {
	return new Catalog(() => {
		for (const path of [catalogPath(), ...fallbacks()]) {
			try {
				const data = JSON.parse(readFileSync(path, 'utf8')) as CatalogData;
				if (data && typeof data === 'object' && Object.keys(data).length) return data;
			} catch { /* try the next */ }
		}
		return undefined;
	});
}
