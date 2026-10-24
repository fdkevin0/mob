// The platform's container runtime CLI: nerdctl (containerd) on Linux,
// Apple's container on macOS, WSL containers (wslc) on Windows.
import { spawn } from 'node:child_process';
import { validatePolicy, type Backend, type Command, type Exit, type Output, type Policy, type Process } from './policy';

export const containerd = 'containerd', apple = 'apple', wslc = 'wslc';
export const runtimeNames = [containerd, apple, wslc];
export const noNetwork = 'none';
export const gvisor = 'gvisor';
const gvisorRuntime = 'runsc';

export class Unavailable extends Error {
	constructor(detail: string) { super('container runtime unavailable: ' + detail); }
}

/** Mount binds a host path into the container; readOnly stops the container from changing it. */
export type Mount = { source: string; target: string; readOnly?: boolean };
/** Limits bound a container; pids, its processes and threads at once, is containerd's alone. */
export type Limits = { network?: string; cpus?: number; memoryMiB?: number; pids?: number };
/** Spec is one container run; user is the UID[:GID] or name it runs as, unset for the image's. */
export type Spec = { name?: string; image: string; command: string[]; env?: string[]; mounts?: Mount[]; workdir?: string; user?: string; stdin?: boolean; limits?: Limits; isolation?: string };

export type { Output };

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
		if (spec.user) {
			if (!validUser(spec.user)) throw new Error(`user "${spec.user}" must be a UID[:GID] or name`);
			args.push('--user', spec.user);
		}
		args.push(...limitArgs(spec.limits ?? {}));
		if (spec.limits?.pids) {
			if (this.name !== containerd) throw new Error(`a process limit needs the ${containerd} runtime`);
			args.push('--pids-limit', String(spec.limits.pids));
		}
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
			args.push('-v', m.source + ':' + m.target + (m.readOnly ? ':ro' : ''));
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
	if ((l.cpus ?? 0) < 0 || (l.memoryMiB ?? 0) < 0 || (l.pids ?? 0) < 0) throw new Error('CPU, memory and process limits must not be negative');
	if (l.cpus) args.push('--cpus', String(l.cpus));
	if (l.memoryMiB) args.push('--memory', l.memoryMiB + 'm');
	return args;
}

/** validUser reports whether s names a user as all three CLIs read --user: a name or number, optionally :group. */
export const validUser = (s: string) => /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(:[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/.test(s);

/** parseMemory reads a size with a unit, such as 512m or 2g, in MiB. */
export function parseMemory(s: string): number {
	const m = /^([0-9.]+)\s*([mgt])i?b?$/.exec(s.trim().toLowerCase());
	const mib = m ? Number(m[1]) * { m: 1, g: 1024, t: 1024 * 1024 }[m[2] as 'm' | 'g' | 't'] : NaN;
	if (!(mib >= 1 && mib <= 1 << 30)) throw new Error('memory must be a size with a unit, such as 512m or 2g');
	return Math.trunc(mib);
}

/** ContainerBackend runs each process in a fresh container; only the policy's mounts are visible. */
export class ContainerBackend implements Backend {
	private pulled = false;
	private pulling?: Promise<void>;

	constructor(readonly runtime: Runtime, readonly image: string, readonly isolation = '') {}

	get name() { return this.runtime.name; }

	supports(p: Policy) {
		validatePolicy(p);
		this.runtime.runArgs(this.spec(p, []));
	}

	check(signal?: AbortSignal) { return this.runtime.check(signal); }

	/** prepare pulls the image once; without a registry an image already present still runs. */
	async prepare(signal?: AbortSignal) {
		if (this.pulled) return;
		this.pulling ??= (async () => {
			try {
				await this.runtime.pull(this.image, signal);
				this.pulled = true;
			} catch (e) {
				if (signal?.aborted) throw e;
				await this.runtime.check(signal);
			}
		})().finally(() => { this.pulling = undefined; });
		await this.pulling;
	}

	/** start names the container so that it can be removed: an interrupted CLI may leave it running. */
	start(p: Policy, cmd: Command, signal?: AbortSignal): Process {
		if (!cmd.args.length) throw new Error('command is required');
		this.supports(p);
		const name = 'mob-' + random();
		const killer = new AbortController();
		const stop = signal ? AbortSignal.any([signal, killer.signal]) : killer.signal;
		const done = (async (): Promise<Exit> => {
			let code = -1, failure: unknown;
			try {
				code = await this.runtime.stream({ ...this.spec(p, cmd.args), name, stdin: !!cmd.stdin }, { stdin: cmd.stdin, stdout: cmd.stdout, stderr: cmd.stderr, signal: stop });
			} catch (e) { failure = e; }
			if (stop.aborted) {
				await this.runtime.removeContainer(name, AbortSignal.timeout(30_000)).catch(() => {});
				return { code };
			}
			if (failure) throw new Unavailable((failure as Error).message);
			return { code };
		})();
		return { done, kill: () => killer.abort() };
	}

	private spec(p: Policy, command: string[]): Spec {
		return {
			image: this.image, command, env: p.env, workdir: p.workdir, user: p.user, isolation: this.isolation,
			mounts: p.mounts.map(m => ({ source: m.source, target: m.target, readOnly: m.readOnly })),
			limits: { network: p.network === 'off' ? noNetwork : undefined, cpus: p.limits?.cpus, memoryMiB: p.limits?.memoryMiB, pids: p.limits?.pids },
		};
	}
}

const random = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
