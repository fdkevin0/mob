// What a sandboxed process may reach (Policy), and what enforces it (Backend).
// A policy is plain data; a backend enforces all of it or refuses it in
// supports, never quietly enforcing less.

/** Policy says what a sandboxed process may reach. */
export type Policy = {
	/** mounts are the host directories the process sees, at their target. */
	mounts: PolicyMount[];
	/** network is what it may connect to. */
	network: Network;
	/** env is its whole environment, as KEY=VALUE; nothing of the host's is inherited. */
	env?: string[];
	workdir?: string;
	/** user is the UID[:GID] or name it runs as; unset keeps the backend's default. */
	user?: string;
	limits?: PolicyLimits;
};

/** PolicyMount makes a host directory visible; readOnly forbids changing anything under it. */
export type PolicyMount = { source: string; target: string; readOnly?: boolean };

/** Network is "host" for the network the backend gives by default, which reaches the internet, or "off" for loopback only. */
export type Network = 'host' | 'off';

/** PolicyLimits bound what a process may use; unset or zero leaves a limit to the backend. */
export type PolicyLimits = { cpus?: number; memoryMiB?: number; pids?: number };

/** validatePolicy rejects a policy no backend could enforce. */
export function validatePolicy(p: Policy) {
	if (p.network !== 'host' && p.network !== 'off') throw new Error(`network "${p.network}" must be "host" or "off"`);
	for (const m of p.mounts) if (!m.source || !m.target.startsWith('/')) throw new Error(`mount "${m.source}":"${m.target}" needs a source and an absolute target`);
	for (const e of p.env ?? []) if (!e.includes('=') || e.startsWith('=')) throw new Error(`environment entry "${e}" must be KEY=VALUE`);
	const l = p.limits ?? {};
	for (const n of [l.cpus, l.memoryMiB, l.pids]) if (n !== undefined && !(Number.isInteger(n) && n >= 0)) throw new Error('CPU, memory and process limits must be whole numbers, not negative');
}

/** Output receives a stream of a process's bytes. */
export type Output = (chunk: Uint8Array) => void;

/** Command is a program to run under a policy, with its standard streams; unset ones read nothing and discard output. */
export type Command = { args: string[]; stdin?: NodeJS.ReadableStream; stdout?: Output; stderr?: Output };

/** Exit is how a sandboxed process ended. A nonzero code is not an error; timedOut is set by run. */
export type Exit = { code: number; timedOut?: boolean };

/** Process is a started sandboxed process: done settles when it ends, and rejects only when the backend failed. */
export type Process = { done: Promise<Exit>; kill(): void };

/** Backend enforces a Policy on the processes it starts. */
export interface Backend {
	/** name identifies the backend in logs and messages. */
	readonly name: string;
	/** supports throws why the backend cannot enforce p. */
	supports(p: Policy): void;
	/** check fails when the backend cannot start processes now, without changing anything. */
	check(signal?: AbortSignal): Promise<void>;
	/** prepare readies the backend, such as by fetching an image, and fails when it cannot start processes. */
	prepare(signal?: AbortSignal): Promise<void>;
	/** start runs cmd under p; the process is killed when signal aborts. */
	start(p: Policy, cmd: Command, signal?: AbortSignal): Process;
}

/** run runs cmd under p and waits for it, killing it after timeoutMs. A timeout is a result; signal aborting is an error. */
export async function run(b: Backend, p: Policy, cmd: Command, timeoutMs: number, signal?: AbortSignal): Promise<Exit> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const proc = b.start(p, cmd, signal ? AbortSignal.any([signal, timeout]) : timeout);
	const exit = await proc.done;
	if (signal?.aborted) throw signal.reason;
	if (timeout.aborted) return { ...exit, timedOut: true };
	return exit;
}

/** inheritedEnv is Mob's own environment without its MOB_* variables, such as its access token, plus extra KEY=VALUE entries, for processes it starts on the host. */
export function inheritedEnv(extra: string[] = []): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('MOB_')) env[k] = v;
	for (const entry of extra) { const i = entry.indexOf('='); env[entry.slice(0, i)] = entry.slice(i + 1); }
	return env;
}
