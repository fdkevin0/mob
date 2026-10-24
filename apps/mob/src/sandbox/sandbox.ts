// The sandbox runs the model's commands, each in a new process of its backend
// whose only host directory is the conversation's workspace.
import { join } from 'node:path';
import { sandboxDefaultTimeout, sandboxMaxTimeout, type Sandbox as CoreSandbox, type SandboxResult, type Saver } from '@mob/core';
import type { SandboxSettings } from '../config';
import { ContainerBackend, Runtime, defaultRuntime, gvisor, containerd, noNetwork, parseMemory, runtimeNames, validUser, type Runner } from './container';
import { run, type Backend, type Policy } from './policy';
import { openWorkspace, safeDir, writeNew } from './workspace';

export const workdir = '/workspace';
const outputCap = 1 << 20, minMemoryMiB = 64;

export function validateSandbox(s: SandboxSettings) {
	if (s.runtime) {
		try { new Runtime(s.runtime); } catch { throw new Error(`sandbox.runtime must be ${runtimeNames.join(', ')} or empty`); }
	}
	if (!s.image || s.image.startsWith('-') || /\s/.test(s.image)) throw new Error('sandbox.image must be an image reference');
	if (s.user && !validUser(s.user)) throw new Error('sandbox.user must be a UID[:GID] or user name, or empty');
	policy(s);
	// An empty runtime is this platform's own, so an option only containerd
	// offers fails here on macOS or Windows rather than on the first command.
	let name = '';
	try { name = Runtime.open(s.runtime).name; } catch { /* below */ }
	if (s.pids && name !== containerd) throw new Error('sandbox.pids needs the containerd runtime (Linux)');
	if (s.isolation) {
		if (s.isolation !== gvisor) throw new Error('sandbox.isolation must be "gvisor" or empty');
		if (name !== containerd) throw new Error('sandbox.isolation "gvisor" needs the containerd runtime (Linux)');
	}
}

/** policy is what the settings allow every command; the workspace mount is added per conversation. */
function policy(s: SandboxSettings): Policy {
	if (s.network && s.network !== noNetwork) throw new Error('sandbox.network must be "none" or empty');
	if (s.cpus < 0 || !Number.isInteger(s.cpus)) throw new Error("sandbox.cpus must be a whole number of CPUs, or 0 for the runtime's default");
	if (s.pids < 0 || !Number.isInteger(s.pids)) throw new Error("sandbox.pids must be a number of processes, or 0 for the runtime's default");
	const p: Policy = { mounts: [], network: s.network === noNetwork ? 'off' : 'host', workdir, user: s.user || undefined, limits: { cpus: s.cpus, pids: s.pids } };
	if (s.memory) {
		let mib = 0;
		try { mib = parseMemory(s.memory); } catch { /* below */ }
		if (mib < minMemoryMiB) throw new Error(`sandbox.memory must be a size of at least ${minMemoryMiB}m, such as 512m or 2g, or empty`);
		p.limits!.memoryMiB = mib;
	}
	return p;
}

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
	readonly root: string;

	/** policy is what every command may reach, apart from its workspace. */
	constructor(readonly backend: Backend, readonly policy: Policy, dataDir: string) {
		this.root = join(dataDir, 'sandbox');
	}

	/** create is the sandbox settings describe, or undefined while it is off; tests replace the runner. */
	static create(s: SandboxSettings, dataDir: string, runner?: Runner) {
		if (!s.enabled) return undefined;
		validateSandbox(s);
		return new Sandbox(new ContainerBackend(new Runtime(s.runtime || defaultRuntime(), runner), s.image, s.isolation), policy(s), dataDir);
	}

	offline() { return this.policy.network === 'off'; }

	/** workspace is the conversation's directory, the only host path its commands reach. */
	workspace(conversationID: string) {
		if (!conversationID || /[^0-9a-fA-F]/.test(conversationID)) throw new Error('invalid conversation ID');
		return openWorkspace(this.root, join(this.root, conversationID));
	}

	/** save keeps a large tool output in the workspace and returns its path inside the container. */
	async save(conversationID: string, name: string, text: string) {
		if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new Error('invalid file name');
		// Commands control the workspace and may plant links in it.
		writeNew(safeDir(this.workspace(conversationID), '.mob/outputs'), name, text);
		return [workdir, '.mob', 'outputs', name].join('/');
	}

	async exec(conversationID: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult> {
		if (!command.trim()) throw new Error('command is required');
		if (timeoutMs <= 0 || timeoutMs > sandboxMaxTimeout) timeoutMs = sandboxDefaultTimeout;
		const workspace = this.workspace(conversationID);
		await this.backend.prepare(signal);
		const p: Policy = { ...this.policy, mounts: [{ source: workspace, target: workdir }, ...this.policy.mounts] };
		const stdout = capture(), stderr = capture();
		const exit = await run(this.backend, p, { args: ['sh', '-c', command], stdout: stdout.out, stderr: stderr.out }, timeoutMs, signal);
		const result: SandboxResult = { exitCode: exit.code, stdout: stdout.text(), stderr: stderr.text() };
		if (stdout.over || stderr.over) result.truncated = true;
		if (exit.timedOut) result.timedOut = true;
		return result;
	}
}
