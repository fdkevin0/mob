// The platform's container runtime CLI: nerdctl (containerd) on Linux,
// Apple's container on macOS, WSL containers (wslc) on Windows.
import { spawn } from 'node:child_process';

export const containerd = 'containerd', apple = 'apple', wslc = 'wslc';
export const runtimeNames = [containerd, apple, wslc];
export const noNetwork = 'none';
export const gvisor = 'gvisor';
const gvisorRuntime = 'runsc';

export class Unavailable extends Error {
	constructor(detail: string) { super('container runtime unavailable: ' + detail); }
}

export type Mount = { source: string; target: string };
export type Limits = { network?: string; cpus?: number; memoryMiB?: number };
export type Spec = { name?: string; image: string; command: string[]; env?: string[]; mounts?: Mount[]; workdir?: string; stdin?: boolean; limits?: Limits; isolation?: string };

/** Output receives a stream of a command's bytes. */
export type Output = (chunk: Uint8Array) => void;

export const defaultRuntime = (platform = process.platform) => (platform === 'linux' ? containerd : platform === 'darwin' ? apple : platform === 'win32' ? wslc : '');

/** run starts a command; its exit code, or -1 when it could not start. Abort kills it. */
export type Runner = (binary: string, args: string[], io: { stdin?: NodeJS.ReadableStream; stdout?: Output; stderr?: Output; signal?: AbortSignal }) => Promise<number>;

export const run: Runner = (binary, args, io) => new Promise((resolve, reject) => {
	const child = spawn(binary, args, { stdio: [io.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], signal: io.signal, windowsHide: true });
	if (io.stdin) io.stdin.pipe(child.stdin!);
	child.stdout!.on('data', (c: Buffer) => io.stdout?.(c));
	child.stderr!.on('data', (c: Buffer) => io.stderr?.(c));
	child.once('error', e => (io.signal?.aborted ? resolve(-1) : reject(e)));
	child.once('close', code => resolve(code ?? -1));
});

const lastLine = (s: string) => { s = s.trim(); return s ? s.slice(s.lastIndexOf('\n') + 1) : 'no output'; };
const text = () => { let s = ''; const decoder = new TextDecoder(); return { out: ((c: Uint8Array) => { s += decoder.decode(c, { stream: true }); }) as Output, get: () => s }; };

export class Runtime {
	readonly binary: string;
	private prefix: string[] = [];
	private probe: string[];
	private stop?: string[];
	private remove: string[];

	constructor(readonly name: string, readonly runner: Runner = run) {
		switch (name) {
			case containerd: this.binary = 'nerdctl'; this.prefix = ['--namespace', 'mob']; this.probe = ['info']; this.remove = ['rm', '-f']; this.stop = ['stop', '-t', '0']; break;
			case apple: this.binary = 'container'; this.probe = ['system', 'status']; this.remove = ['delete', '--force']; break;
			case wslc: this.binary = 'wslc'; this.probe = ['image', 'ls']; this.remove = ['rm', '-f']; break;
			case '': throw new Unavailable('no native container runtime for ' + process.platform);
			default: throw new Error(`unknown container runtime "${name}" (want ${runtimeNames.join(', ')})`);
		}
	}

	static open(name = '') { return new Runtime(name || defaultRuntime()); }

	private args(...rest: string[]) { return [...this.prefix, ...rest]; }

	async check(signal?: AbortSignal) {
		const err = text();
		let code;
		try { code = await this.runner(this.binary, this.args(...this.probe), { stderr: err.out, signal }); } catch (e) { throw new Unavailable(`${this.binary}: ${(e as Error).message}`); }
		if (code !== 0) throw new Unavailable(`${this.binary} ${this.probe.join(' ')}: ${lastLine(err.get())}`);
	}

	async pull(image: string, signal?: AbortSignal) {
		if (!image || image.startsWith('-')) throw new Error('image is required and must not start with -');
		const err = text();
		const code = await this.runner(this.binary, this.args('image', 'pull', image), { stderr: err.out, signal });
		if (code !== 0) throw new Error(`pull ${image}: ${lastLine(err.get())}`);
	}

	async removeContainer(name: string, signal?: AbortSignal) {
		if (!name || name.startsWith('-')) throw new Error('container name is required and must not start with -');
		if (this.stop) await this.runner(this.binary, this.args(...this.stop, name), { signal }).catch(() => {});
		const err = text();
		const code = await this.runner(this.binary, this.args(...this.remove, name), { stderr: err.out, signal });
		if (code !== 0) throw new Error(`remove ${name}: ${lastLine(err.get())}`);
	}

	stream(spec: Spec, io: { stdin?: NodeJS.ReadableStream; stdout?: Output; stderr?: Output; signal?: AbortSignal }) {
		return this.runner(this.binary, this.runArgs(spec), io);
	}

	async exec(spec: Spec, signal?: AbortSignal) {
		const out = text(), err = text();
		const exitCode = await this.stream(spec, { stdout: out.out, stderr: err.out, signal });
		return { exitCode, stdout: out.get(), stderr: err.get() };
	}

	runArgs(spec: Spec): string[] {
		if (!spec.image || spec.image.startsWith('-')) throw new Error('image is required and must not start with -');
		const args = ['run', '--rm'];
		if (spec.name) args.push('--name', spec.name);
		if (spec.stdin) args.push('-i');
		if (spec.workdir) args.push('-w', spec.workdir);
		args.push(...limitArgs(spec.limits ?? {}));
		if (spec.isolation) {
			if (spec.isolation !== gvisor) throw new Error(`isolation "${spec.isolation}" must be empty or "${gvisor}"`);
			if (this.name !== containerd) throw new Error(`isolation "${gvisor}" needs the ${containerd} runtime`);
			args.push('--runtime', gvisorRuntime);
		}
		for (const e of spec.env ?? []) {
			if (!e.includes('=') || e.startsWith('=')) throw new Error(`environment entry "${e}" must be KEY=VALUE`);
			args.push('-e', e);
		}
		for (const m of spec.mounts ?? []) {
			if (!m.source || !m.target.startsWith('/')) throw new Error(`mount "${m.source}":"${m.target}" needs a source and an absolute target`);
			args.push('-v', m.source + ':' + m.target);
		}
		return this.args(...args, spec.image, ...spec.command);
	}
}

function limitArgs(l: Limits) {
	const args: string[] = [];
	if (l.network) {
		if (l.network !== noNetwork) throw new Error(`network "${l.network}" must be empty or "${noNetwork}"`);
		args.push('--network', noNetwork);
	}
	if ((l.cpus ?? 0) < 0 || (l.memoryMiB ?? 0) < 0) throw new Error('CPU and memory limits must not be negative');
	if (l.cpus) args.push('--cpus', String(l.cpus));
	if (l.memoryMiB) args.push('--memory', l.memoryMiB + 'm');
	return args;
}

/** parseMemory reads a size with a unit, such as 512m or 2g, in MiB. */
export function parseMemory(s: string): number {
	const m = /^([0-9.]+)\s*([mgt])i?b?$/.exec(s.trim().toLowerCase());
	const mib = m ? Number(m[1]) * { m: 1, g: 1024, t: 1024 * 1024 }[m[2] as 'm' | 'g' | 't'] : NaN;
	if (!(mib >= 1 && mib <= 1 << 30)) throw new Error('memory must be a size with a unit, such as 512m or 2g');
	return Math.trunc(mib);
}
