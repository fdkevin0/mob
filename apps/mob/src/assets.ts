// The web UI's files: embedded in a compiled mob, else read from @mob/app's dist.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { files } from './web';

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
	'.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const typeOf = (path: string) => types[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';

/** directory finds the built web UI: MOB_ASSETS, beside the executable, or @mob/app's dist in the repository. */
function directory(): string | undefined {
	const candidates = [process.env.MOB_ASSETS, join(dirname(process.execPath), 'web'), join(dirname(Bun.resolveSync('@mob/app/package.json', import.meta.dir)), 'dist')];
	return candidates.find(d => d && existsSync(join(d, 'index.html')));
}

export function assets(): (path: string) => Response | undefined {
	const embedded = new Map(Object.entries(files).map(([path, file]) => [path, Bun.file(file) as Blob]));
	const dir = embedded.size ? undefined : directory();
	return path => {
		if (path.endsWith('/')) path += 'index.html';
		path = normalize(decodeURIComponent(path)).replaceAll('\\', '/');
		if (path.includes('..')) return undefined;
		let body: Blob | undefined = embedded.get(path);
		if (!body && dir) {
			const file = join(dir, path);
			if (existsSync(file) && statSync(file).isFile()) body = Bun.file(file);
		}
		if (!body) return undefined;
		return new Response(body, { headers: { 'Content-Type': typeOf(path) } });
	};
}
