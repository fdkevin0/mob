import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxSettings } from '../src/config';
import { ContainerBackend, Runtime, apple, containerd, gvisor, parseMemory, wslc, type Runner, type Spec } from '../src/sandbox/container';
import { run, type Backend, type Policy, type Process } from '../src/sandbox/policy';
import { Sandbox, validateSandbox, workdir } from '../src/sandbox/sandbox';

const conversation = '0123456789abcdef0123456789abcdef';
const temp = () => mkdtempSync(join(tmpdir(), 'sandbox-'));
const settings = (s: Partial<SandboxSettings> = {}): SandboxSettings => ({ enabled: true, runtime: containerd, image: 'alpine:3.20', network: '', cpus: 0, memory: '', pids: 0, user: '', isolation: '', ...s });
const write = (c: string) => new TextEncoder().encode(c);

/** recorder is a runner that records each call and answers with reply. */
function recorder(reply: Runner = async () => 0) {
	const calls: string[][] = [];
	const runner: Runner = (binary, args, io) => { calls.push(args); return reply(binary, args, io); };
	return { calls, runner };
}

test('run arguments are the same for every runtime', () => {
	const spec: Spec = { image: 'python:3.13', command: ['python', '-c', 'print(1)'], env: ['A=1'], mounts: [{ source: '/tmp/w', target: '/work' }, { source: '/tmp/c', target: '/cache', readOnly: true }], workdir: '/work', user: '65534:65534', stdin: true };
	const tail = ['run', '--rm', '-i', '-w', '/work', '--user', '65534:65534', '-e', 'A=1', '-v', '/tmp/w:/work', '-v', '/tmp/c:/cache:ro', 'python:3.13', 'python', '-c', 'print(1)'];
	for (const [name, binary] of [[containerd, 'nerdctl'], [apple, 'container'], [wslc, 'wslc']] as const) {
		const r = new Runtime(name);
		expect(r.binary).toBe(binary);
		expect(r.runArgs(spec)).toEqual(name === containerd ? ['--namespace', 'mob', ...tail] : tail);
	}
	expect(new Runtime(wslc).runArgs({ image: 'alpine', command: ['ls'], workdir: '/w', limits: { network: 'none', cpus: 2, memoryMiB: 1536 } }).join(' ')).toBe('run --rm -w /w --network none --cpus 2 --memory 1536m alpine ls');
	const c = new Runtime(containerd);
	expect(c.runArgs({ image: 'alpine', command: ['ls'], limits: { network: 'none', pids: 64 }, isolation: gvisor }).join(' ')).toBe('--namespace mob run --rm --network none --pids-limit 64 --runtime runsc alpine ls');
	for (const name of [apple, wslc]) {
		expect(() => new Runtime(name).runArgs({ image: 'alpine', command: [], isolation: gvisor })).toThrow('containerd');
		expect(() => new Runtime(name).runArgs({ image: 'alpine', command: [], limits: { pids: 64 } })).toThrow('containerd');
	}
	const bad: Spec[] = [{ image: '', command: [] }, { image: '--privileged', command: [] }, { image: 'alpine', command: [], isolation: 'kata' }, { image: 'alpine', command: [], env: ['=x'] },
		{ image: 'alpine', command: [], mounts: [{ source: '/a', target: 'relative' }] }, { image: 'alpine', command: [], limits: { network: 'host' } }, { image: 'alpine', command: [], limits: { pids: -1 } },
		{ image: 'alpine', command: [], user: '-u' }, { image: 'alpine', command: [], user: 'a:' }, { image: 'alpine', command: [], user: 'a b' }];
	for (const spec of bad) expect(() => c.runArgs(spec)).toThrow();
	expect(() => new Runtime('docker')).toThrow('containerd, apple, wslc');
});

test('parseMemory needs a unit', () => {
	for (const [s, want] of [['512m', 512], ['2g', 2048], ['1.5GiB', 1536], [' 3gb ', 3072], ['1t', 1 << 20]] as const) expect(parseMemory(s)).toBe(want);
	for (const s of ['', '512', '512k', 'g', '-1g', '0m', '0.5m', '2048t']) expect(() => parseMemory(s)).toThrow();
});

test('settings that could never run are refused', () => {
	validateSandbox(settings({ user: '65534:65534', pids: 128, network: 'none', cpus: 2, memory: '1g', isolation: gvisor }));
	for (const s of [{ runtime: 'docker' }, { image: '' }, { image: '--privileged' }, { image: 'a b' }, { network: 'host' }, { cpus: -1 }, { cpus: 1.5 }, { memory: '512' }, { memory: '32m' },
		{ pids: -1 }, { user: '-0' }, { user: 'a:b:c' }, { isolation: 'kata' }, { runtime: apple, isolation: gvisor }, { runtime: wslc, isolation: gvisor }, { runtime: apple, pids: 64 }, { runtime: wslc, pids: 64 }]) {
		expect(() => validateSandbox(settings(s))).toThrow();
	}
	expect(Sandbox.create(settings({ enabled: false }), temp())).toBeUndefined();
});

test('exec mounts only the workspace and passes the limits', async () => {
	const { calls, runner } = recorder(async (_b, args, io) => {
		if (args.includes('run')) { io.stdout?.(write('x'.repeat((1 << 20) + 10))); io.stderr?.(write('warn')); return 7; }
		return 0;
	});
	const box = Sandbox.create(settings({ network: 'none', cpus: 1, memory: '1g', pids: 32, user: '65534:65534' }), temp(), runner)!;
	expect(box.offline()).toBe(true);
	for (let i = 0; i < 2; i++) {
		const r = await box.exec(conversation, 'pip install x && ls', 0);
		expect(r).toMatchObject({ exitCode: 7, stderr: 'warn', truncated: true });
		expect(r.stdout.length).toBe(1 << 20);
	}
	expect(calls.length).toBe(3);
	expect(calls[0]!.join(' ')).toBe('--namespace mob image pull alpine:3.20');
	const workspace = join(box.root, conversation);
	const call = calls[1]!.join(' ');
	expect(call).toStartWith('--namespace mob run --rm --name mob-');
	expect(call).toEndWith(`-w /workspace --user 65534:65534 --network none --cpus 1 --memory 1024m --pids-limit 32 -v ${workspace}:/workspace alpine:3.20 sh -c pip install x && ls`);
	expect(statSync(workspace).isDirectory()).toBe(true);
	expect(box.exec('../escape', 'ls', 0)).rejects.toThrow('invalid conversation ID');
	expect(box.exec(conversation, '  ', 0)).rejects.toThrow('command is required');
	expect(Sandbox.create(settings(), temp(), runner)!.offline()).toBe(false);
});

test('a timeout removes the container and is a result; a cancelled turn is an error', async () => {
	let stopped = '', removed = '';
	const { runner } = recorder((_b, args, io) => {
		if (args.includes('run')) {
			io.stdout?.(write('partial'));
			return new Promise(resolve => io.signal!.addEventListener('abort', () => resolve(-1)));
		}
		if (args.includes('stop')) stopped = args.at(-1)!;
		// containerd stops first: under gVisor rm -f alone leaves the container behind.
		if (args.includes('rm') && stopped === args.at(-1)) removed = stopped;
		return Promise.resolve(0);
	});
	const box = Sandbox.create(settings(), temp(), runner)!;
	const r = await box.exec(conversation, 'sleep 100', 20);
	expect(r).toMatchObject({ timedOut: true, stdout: 'partial' });
	expect(removed).toStartWith('mob-');
	const turn = new AbortController();
	setTimeout(() => turn.abort(new Error('turn cancelled')), 20);
	expect(box.exec(conversation, 'sleep 100', 60_000, turn.signal)).rejects.toThrow('turn cancelled');
});

test('a failed pull leaves the run to a local image', async () => {
	const { runner } = recorder(async (_b, args, io) => {
		if (args.includes('pull')) { io.stderr?.(write('429 Too Many Requests')); return 1; }
		return 0;
	});
	expect((await Sandbox.create(settings(), temp(), runner)!.exec(conversation, 'ls', 1000)).exitCode).toBe(0);
});

/** sleeper is a backend whose processes end with code after delayMs, or when killed. */
function sleeper(delayMs: number, code = 0, failure?: Error): Backend {
	return {
		name: 'sleeper', supports: () => {}, check: async () => {}, prepare: async () => {},
		start(_p, _cmd, signal): Process {
			let kill = () => {};
			const done = new Promise<{ code: number }>((resolve, reject) => {
				const t = setTimeout(() => (failure ? reject(failure) : resolve({ code })), delayMs);
				kill = () => { clearTimeout(t); resolve({ code: -1 }); };
				signal?.addEventListener('abort', kill);
			});
			return { done, kill };
		},
	};
}

test('run reports timeouts as results and failures as errors', async () => {
	const p: Policy = { mounts: [], network: 'host' };
	expect(await run(sleeper(0, 3), p, { args: ['x'] }, 1000)).toEqual({ code: 3 });
	expect(await run(sleeper(60_000), p, { args: ['x'] }, 10)).toEqual({ code: -1, timedOut: true });
	expect(run(sleeper(0, 0, new Error('runtime gone')), p, { args: ['x'] }, 1000)).rejects.toThrow('runtime gone');
	const turn = new AbortController();
	setTimeout(() => turn.abort(new Error('stop')), 10);
	expect(run(sleeper(60_000), p, { args: ['x'] }, 60_000, turn.signal)).rejects.toThrow('stop');
});

test('the container backend refuses what its runtime cannot enforce', () => {
	const p: Policy = { mounts: [{ source: '/src', target: '/w' }], network: 'off', limits: { pids: 8 } };
	new ContainerBackend(new Runtime(containerd), 'alpine').supports(p);
	expect(() => new ContainerBackend(new Runtime(apple), 'alpine').supports(p)).toThrow('containerd');
	expect(() => new ContainerBackend(new Runtime(containerd), 'alpine').supports({ ...p, network: 'allow' as 'off' })).toThrow('network');
	expect(() => new ContainerBackend(new Runtime(containerd), 'alpine').start(p, { args: [] })).toThrow('command is required');
});

test('save writes into the workspace and never through a link', async () => {
	const box = Sandbox.create(settings(), temp(), recorder().runner)!;
	expect(await box.save(conversation, 'out.txt', 'whole output')).toBe(workdir + '/.mob/outputs/out.txt');
	const outputs = join(box.root, conversation, '.mob', 'outputs');
	expect(readFileSync(join(outputs, 'out.txt'), 'utf8')).toBe('whole output');
	for (const name of ['', '../x', 'a/b', '.hidden']) expect(box.save(conversation, name, 'x')).rejects.toThrow('invalid file name');
	// Commands may replace the outputs directory, or a file in it, with a link.
	const outside = temp(), host = join(outside, 'host.txt');
	writeFileSync(host, 'host file');
	symlinkSync(host, join(outputs, 'link.txt'));
	expect(box.save(conversation, 'link.txt', 'overwritten')).rejects.toThrow();
	const other = '0123456789abcdef0123456789abcde0';
	mkdirSync(join(box.root, other, '.mob'), { recursive: true });
	symlinkSync(outside, join(box.root, other, '.mob', 'outputs'));
	expect(box.save(other, 'new.txt', 'x')).rejects.toThrow('not a directory');
	expect(readFileSync(host, 'utf8')).toBe('host file');
	expect(existsSync(join(outside, 'new.txt'))).toBe(false);
});

test.skipIf(process.platform === 'win32')('a workspace is open to every container user, inside a root private to Mob', async () => {
	const old = process.umask(0o077);
	try {
		const box = Sandbox.create(settings(), temp(), recorder().runner)!;
		await box.save(conversation, 'out.txt', 'x');
		const workspace = join(box.root, conversation);
		const modes = Object.fromEntries([box.root, workspace, join(workspace, '.mob'), join(workspace, '.mob', 'outputs'), join(workspace, '.mob', 'outputs', 'out.txt')].map(p => [p, statSync(p).mode & 0o777]));
		expect(Object.values(modes)).toEqual([0o700, 0o777, 0o755, 0o755, 0o644]);
	} finally {
		process.umask(old);
	}
});

// A real container: set MOB_SANDBOX_TEST_IMAGE to an image with sh, and
// MOB_SANDBOX_TEST_RUNTIME for another runtime than this platform's own.
test.skipIf(!process.env.MOB_SANDBOX_TEST_IMAGE)('a non-root user reads what Mob saved and writes the workspace', async () => {
	const box = Sandbox.create(settings({ runtime: process.env.MOB_SANDBOX_TEST_RUNTIME ?? '', image: process.env.MOB_SANDBOX_TEST_IMAGE!, network: 'none', user: '65534:65534' }), temp())!;
	const saved = await box.save(conversation, 'in.txt', 'saved by Mob');
	const r = await box.exec(conversation, `id -u && cat ${saved} && echo && echo written > /workspace/out.txt && mkdir -p /workspace/venv/bin && echo ok`, 60_000);
	expect(r).toMatchObject({ exitCode: 0, stdout: '65534\nsaved by Mob\nok\n' });
	expect(readFileSync(join(box.root, conversation, 'out.txt'), 'utf8').trim()).toBe('written');
}, 120_000);
