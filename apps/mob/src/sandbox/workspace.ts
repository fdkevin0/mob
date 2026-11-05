// Writing into a sandbox workspace. Commands control the workspace and may
// plant links in it, so writing refuses to follow them.
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';

const dirMode = 0o700, fileMode = 0o600;

/**
 * safeDir creates rel's directories under root, refusing any that is a link,
 * and returns the last.
 */
export function safeDir(root: string, rel: string) {
	let at = root;
	for (const part of rel.split('/').filter(Boolean)) {
		at = join(at, part);
		try {
			if (!lstatSync(at).isDirectory()) throw new Error(`${relative(root, at)} in the workspace is not a directory`);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			mkdirSync(at, { mode: dirMode });
		}
	}
	return at;
}

/** writeNew writes data to a new file in dir, never through a link. */
export function writeNew(dir: string, name: string, data: string | Uint8Array) {
	const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
	try {
		writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
	} finally {
		closeSync(fd);
	}
}
