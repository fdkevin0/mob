// The sandbox runs the model's commands in a container whose only host
// directory is the conversation's workspace.
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex, sandboxDefaultTimeout, sandboxMaxTimeout, type Sandbox as CoreSandbox, type SandboxResult, type Saver } from '@mob/core';
import type { SandboxSettings } from '../config';
import { Runtime, gvisor, containerd, noNetwork, parseMemory, runtimeNames, Unavailable, type Limits } from './container';

export const workdir = '/workspace';
const outputCap = 1 << 20, minMemoryMiB = 64;

export function validateSandbox(s: SandboxSettings) {
	if (s.runtime) {
		try { new Runtime(s.runtime); } catch { throw new Error(`sandbox.runtime must be ${runtimeNames.join(', ')} or empty`); }
	}
	if (!s.image || s.image.startsWith('-') || /\s/.test(s.image)) throw new Error('sandbox.image must be an image reference');
	limits(s);
	if (s.isolation) {
		if (s.isolation !== gvisor) throw new Error('sandbox.isolation must be "gvisor" or empty');
		let name = '';
		try { name = Runtime.open(s.runtime).name; } catch { /* below */ }
		if (name !== containerd) throw new Error('sandbox.isolation "gvisor" needs the containerd runtime (Linux)');
	}
}

function limits(s: SandboxSettings): Limits {
	const l: Limits = { network: s.network, cpus: s.cpus };
	if (s.network && s.network !== noNetwork) throw new Error('sandbox.network must be "none" or empty');
	if (s.cpus < 0 || !Number.isInteger(s.cpus)) throw new Error("sandbox.cpus must be a whole number of CPUs, or 0 for the runtime's default");
	if (s.memory) {
		let mib = 0;
		try { mib = parseMemory(s.memory); } catch { /* below */ }
		if (mib < minMemoryMiB) throw new Error(`sandbox.memory must be a size of at least ${minMemoryMiB}m, such as 512m or 2g, or empty`);
		l.memoryMiB = mib;
	}
	return l;
}

const random = () => randomHex(8);

/** capture keeps at most outputCap bytes of a stream. */
function capture() {
	const chunks: Uint8Array[] = [];
	let size = 0, over = false;
	return {
		out: (c: Uint8Array) => {
			const room = outputCap - size;
			if (c.length > room) { over = true; c = c.subarray(0, Math.max(room, 0)); }
			chunks.push(c); size += c.length;
		},
		text: () => new TextDecoder().decode(Buffer.concat(chunks)),
		get over() { return over; },
	};
}

export class Sandbox implements CoreSandbox, Saver {
	private pulled = false;
	private pulling?: Promise<void>;
	readonly limits: Limits;
	readonly root: string;

	constructor(readonly runtime: Runtime, readonly image: string, settings: SandboxSettings, dataDir: string) {
		this.limits = limits(settings);
		this.isolation = settings.isolation;
		this.root = join(dataDir, 'sandbox');
	}
	readonly isolation: string;

	/** create is the sandbox settings describe, or undefined while it is off. */
	static create(s: SandboxSettings, dataDir: string) {
		if (!s.enabled) return undefined;
		validateSandbox(s);
		return new Sandbox(Runtime.open(s.runtime), s.image, s, dataDir);
	}

	offline() { return this.limits.network === noNetwork; }

	/** workspace is the conversation's directory, the only host path its commands reach. */
	workspace(conversationID: string) {
		if (!conversationID || /[^0-9a-fA-F]/.test(conversationID)) throw new Error('invalid conversation ID');
		const dir = join(this.root, conversationID);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	/** save keeps a large tool output in the workspace and returns its path inside the container. */
	async save(conversationID: string, name: string, text: string) {
		if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new Error('invalid file name');
		const dir = join(this.workspace(conversationID), '.mob', 'outputs');
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const fd = openSync(join(dir, name), 'wx', 0o600);
		try { writeSync(fd, text); } finally { closeSync(fd); }
		return [workdir, '.mob', 'outputs', name].join('/');
	}

	async exec(conversationID: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult> {
		if (!command.trim()) throw new Error('command is required');
		if (timeoutMs <= 0 || timeoutMs > sandboxMaxTimeout) timeoutMs = sandboxDefaultTimeout;
		const workspace = this.workspace(conversationID);
		await this.pull(signal);
		const name = 'mob-' + random();
		const timeout = AbortSignal.timeout(timeoutMs);
		const run = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const stdout = capture(), stderr = capture();
		let code = -1, failure: unknown;
		try {
			code = await this.runtime.stream({ name, image: this.image, command: ['sh', '-c', command], mounts: [{ source: workspace, target: workdir }], workdir, limits: this.limits, isolation: this.isolation }, { stdout: stdout.out, stderr: stderr.out, signal: run });
		} catch (e) { failure = e; }
		const result: SandboxResult = { exitCode: code, stdout: stdout.text(), stderr: stderr.text() };
		if (stdout.over || stderr.over) result.truncated = true;
		if (run.aborted) {
			await this.runtime.removeContainer(name, AbortSignal.timeout(30_000)).catch(() => {});
			if (signal?.aborted) throw signal.reason;
			result.timedOut = true;
			return result;
		}
		if (failure) throw new Unavailable((failure as Error).message);
		return result;
	}

	private async pull(signal?: AbortSignal) {
		if (this.pulled) return;
		this.pulling ??= (async () => {
			try {
				await this.runtime.pull(this.image, signal);
				this.pulled = true;
			} catch (e) {
				if (signal?.aborted) throw e;
				// Without a registry an image already present still runs.
				await this.runtime.check(signal);
			}
		})().finally(() => { this.pulling = undefined; });
		await this.pulling;
	}
}
