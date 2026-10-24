// Writing into a sandbox workspace. Commands may run as any user, such as
// sandbox.user or an image's own, and a bind mount keeps the host's owners
// and modes, so a workspace is open to every user and what Mob writes into it
// readable by all. The directory that holds every workspace is Mob's user's
// alone, which keeps them from the host's other users.
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';

export const rootMode = 0o700, workspaceMode = 0o777;
const sharedDir = 0o755, sharedFile = 0o644, sharedProgram = 0o755;

/** openWorkspace creates dir, open to every user, under root, kept private to Mob's user. */
export function openWorkspace(root: string, dir: string) {
	mkdirSync(dir, { recursive: true, mode: rootMode });
	chmodSync(root, rootMode);
	chmodSync(dir, workspaceMode);
	return dir;
}

/**
 * safeDir creates rel's directories under root, readable by every user, and
 * returns the last. Commands control the workspace and may plant links in it,
 * so a link where a directory should be is refused. Directories that already
 * exist are left as they are, since commands may own them.
 */
export function safeDir(root: string, rel: string) {
	let at = root;
	for (const part of rel.split('/').filter(Boolean)) {
		at = join(at, part);
		try {
			if (!lstatSync(at).isDirectory()) throw new Error(`${relative(root, at)} in the workspace is not a directory`);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			mkdirSync(at, { mode: sharedDir });
			// A umask may have taken away what the other users need.
			chmodSync(at, sharedDir);
		}
	}
	return at;
}

/** writeNew writes data to a new file in dir, never through a link, readable by every user and runnable by all if executable. */
export function writeNew(dir: string, name: string, data: string | Uint8Array, executable = false) {
	const mode = executable ? sharedProgram : sharedFile;
	const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
	try {
		writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
	} finally {
		closeSync(fd);
	}
	chmodSync(join(dir, name), mode);
}
