// The web UI's files: embedded in a compiled mob, else read from @mob/app's dist.
import { statSync } from 'node:fs';
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
	return candidates.find(d => d && Bun.file(join(d, 'index.html')).size > 0);
}

export function assets(): (path: string) => Promise<Response | undefined> | Response | undefined {
	const embedded = new Map(Object.entries(files).map(([path, file]) => [path, Bun.file(file) as Blob]));
	const dir = embedded.size ? undefined : directory();
	return async path => {
		if (path.endsWith('/')) path += 'index.html';
		try { path = normalize(decodeURIComponent(path)).replaceAll('\\', '/'); } catch { return undefined; }
		if (path.includes('..')) return undefined;
		let body: Blob | undefined = embedded.get(path);
		if (!body && dir) {
			const file = join(dir, path);
			const f = Bun.file(file);
			if (await f.exists() && statSync(file).isFile()) body = f;
		}
		if (!body) return undefined;
		return new Response(body, { headers: { 'Content-Type': typeOf(path) } });
	};
}
