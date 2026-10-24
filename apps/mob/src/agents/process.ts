// Starting an agent, and git, as child processes.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { command, type Preset } from './presets';

/** Conn is a started agent's standard input and output. */
export type Conn = {
	input: WritableStream<Uint8Array>;
	output: ReadableStream<Uint8Array>;
	/** stop ends the agent. */
	stop: () => void;
	/** stderr is the end of what the agent wrote to standard error. */
	stderr?: () => string;
};

/** environment is Mob's environment without its own MOB_* variables, such as its access token. */
export function environment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('MOB_')) env[k] = v;
	return env;
}

const windows = process.platform === 'win32';

/** kill ends child and, on Unix, everything it started in its process group, such as the binary npx runs. */
export function kill(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
	try {
		if (windows) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
		else process.kill(-child.pid, 'SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
}

/** grouped spawns a process that, on Unix, leads its own group, so kill ends what it starts too. */
export const grouped = (cmd: string, args: string[], dir: string, env: Record<string, string>) =>
	spawn(cmd, args, { cwd: dir, env, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

const tailSize = 4 << 10;

/** start runs the first installed command of p in dir. */
export function start(p: Preset, dir: string): Conn {
	const found = command(p);
	if (!found) throw new Error(`${p.title} is not installed: install ${p.commands[0]![0]}, or Node.js for npx`);
	const args = found.slice(1);
	let patch = '';
	if (p.patch) {
		// A file of its own, which nobody else can have written.
		patch = join(tmpdir(), `mob-agent-${randomUUID()}.patch.yml`);
		writeFileSync(patch, p.patch, { flag: 'wx', mode: 0o600 });
		args.push('--patch', patch);
	}
	let child: ChildProcess;
	try { child = grouped(found[0]!, args, dir, { ...environment(), ...p.env }); } catch (e) {
		if (patch) rmSync(patch, { force: true });
		throw e;
	}
	let tail = '';
	child.stderr!.setEncoding('utf8').on('data', (s: string) => { tail = (tail + s).slice(-tailSize); });
	child.on('error', () => {});
	child.stdin!.on('error', () => {});
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		child.stdin!.destroy();
		kill(child);
		if (patch) rmSync(patch, { force: true });
	};
	child.on('exit', () => { if (patch) rmSync(patch, { force: true }); });
	return {
		input: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
		output: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
		stop, stderr: () => tail.trim(),
	};
}

/** git runs git in dir and returns its trimmed output; it fails with what git wrote to standard error. */
export async function git(dir: string, ...args: string[]): Promise<string> {
	const p = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(err.trim() || `git exited with ${code}`);
	return out.trim();
}

/** slug is title in lower-case ASCII letters, digits and dashes, for a branch. */
export function slug(title: string) {
	let b = '', dash = false;
	for (const r of title.toLowerCase()) {
		if (/[a-z0-9]/.test(r)) { b += r; dash = false; }
		else if (!dash && b) { b += '-'; dash = true; }
		if (b.length >= 40) break;
	}
	return b.replace(/^-+|-+$/g, '') || 'task';
}

/** firstLine is the first line of text, cut to n characters. */
export function firstLine(text: string, n: number) {
	const line = text.trim().split('\n')[0] ?? '';
	const chars = [...line];
	return chars.length > n ? chars.slice(0, n).join('') : line;
}
