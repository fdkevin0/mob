import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type Connection = { url: string; token: string };

// The mob binary ships inside the app's resources; MOB_BINARY overrides it for
// development, and a checkout without either finds mob on PATH.
export function mobBinary(resources: string, platform = process.platform, env = process.env): string {
	if (env.MOB_BINARY) return env.MOB_BINARY;
	const bundled = join(resources, 'bin', platform === 'win32' ? 'mob.exe' : 'mob');
	return existsSync(bundled) ? bundled : 'mob';
}

// parseConnection accepts only a loopback HTTP service and a full token, so a
// stray line on stdout never becomes the window's address.
export function parseConnection(stdout: string): Connection {
	let value: unknown;
	try { value = JSON.parse(stdout.trim().split('\n').pop() ?? ''); } catch { throw new Error('mob connection printed no connection'); }
	const { url, token } = (value ?? {}) as Partial<Connection>;
	if (typeof url !== 'string' || typeof token !== 'string' || token.length < 32) throw new Error('mob connection printed no connection');
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('mob connection is not a loopback address');
	return { url: parsed.origin, token };
}

// connect starts the background service when it is not running; the service
// outlives the window, so closing Mob does not stop channels or schedules.
export function connect(binary: string): Promise<Connection> {
	return new Promise((resolve, reject) => {
		execFile(binary, ['connection'], { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
			if (error) return reject(new Error(stderr.trim() || error.message));
			try { resolve(parseConnection(stdout)); } catch (e) { reject(e); }
		});
	});
}
