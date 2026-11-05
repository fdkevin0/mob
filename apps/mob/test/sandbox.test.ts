import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxSettings } from '../src/config';
import { containerd, apple, wslc, gvisor, parseMemory, Runtime, type Runner, type Spec } from '../src/sandbox/container';
import { Sandbox, validateSandbox, workdir } from '../src/sandbox/sandbox';

const conversation = '0123456789abcdef0123456789abcdef';
const temp = () => mkdtempSync(join(tmpdir(), 'sandbox-'));
const settings = (s: Partial<SandboxSettings> = {}): SandboxSettings => ({
	enabled: true,
	runtime: containerd,
	image: 'alpine:3.20',
	network: '',
	cpus: 0,
	memory: '',
	isolation: '',
	...s,
});
const write = (c: string) => new TextEncoder().encode(c);

/** recorder is a runner that records each call and answers with reply. */
function recorder(reply: Runner = async () => 0) {
	const calls: string[][] = [];
	const runner: Runner = (binary, args, io) => { calls.push(args); return reply(binary, args, io); };
	return { calls, runner };
}

test('run arguments are the same for every runtime', () => {
	const spec: Spec = { image: 'python:3.13', command: ['python', '-c', 'print(1)'], env: ['A=1'], mounts: [{ source: '/tmp/w', target: '/work' }], workdir: '/work', stdin: true };
	const tail = ['run', '--rm', '-i', '-w', '/work', '-e', 'A=1', '-v', '/tmp/w:/work', 'python:3.13', 'python', '-c', 'print(1)'];
	for (const [name, binary] of [[containerd, 'nerdctl'], [apple, 'container'], [wslc, 'wslc']] as const) {
		const r = new Runtime(name);
		expect(r.binary).toBe(binary);
		expect(r.runArgs(spec)).toEqual(name === containerd ? ['--namespace', 'mob', ...tail] : tail);
	}
	expect(new Runtime(wslc).runArgs({ image: 'alpine', command: ['ls'], workdir: '/w', limits: { network: 'none', cpus: 2, memoryMiB: 1536 } }).join(' ')).toBe('run --rm -w /w --network none --cpus 2 --memory 1536m alpine ls');
	const c = new Runtime(containerd);
	expect(c.runArgs({ image: 'alpine', command: ['ls'], limits: { network: 'none' }, isolation: gvisor }).join(' ')).toBe('--namespace mob run --rm --network none --runtime runsc alpine ls');
	for (const name of [apple, wslc]) {
		expect(() => new Runtime(name).runArgs({ image: 'alpine', command: [], isolation: gvisor })).toThrow('containerd');
	}
	const bad: Spec[] = [{ image: '', command: [] }, { image: '--privileged', command: [] }, { image: 'alpine', command: [], isolation: 'kata' }, { image: 'alpine', command: [], env: ['=x'] },
		{ image: 'alpine', command: [], mounts: [{ source: '/a', target: 'relative' }] }, { image: 'alpine', command: [], limits: { network: 'host' } }];
	for (const spec of bad) expect(() => c.runArgs(spec)).toThrow();
	expect(() => new Runtime('docker')).toThrow('containerd, apple, wslc');
});

test('parseMemory needs a unit', () => {
	for (const [s, want] of [['512m', 512], ['2g', 2048], ['1.5GiB', 1536], [' 3gb ', 3072], ['1t', 1 << 20]] as const) expect(parseMemory(s)).toBe(want);
	for (const s of ['', '512', '512k', 'g', '-1g', '0m', '0.5m', '2048t']) expect(() => parseMemory(s)).toThrow();
});

test('settings that could never run are refused', () => {
	validateSandbox(settings({ network: 'none', cpus: 2, memory: '1g', isolation: gvisor }));
	for (const s of [{ runtime: 'docker' }, { image: '' }, { image: '--privileged' }, { image: 'a b' }, { network: 'host' }, { cpus: -1 }, { cpus: 1.5 }, { memory: '512' }, { memory: '32m' },
		{ isolation: 'kata' }, { runtime: apple, isolation: gvisor }, { runtime: wslc, isolation: gvisor }]) {
		expect(() => validateSandbox(settings(s))).toThrow();
	}
	expect(Sandbox.create(settings({ enabled: false }), temp())).toBeUndefined();
});

test('exec mounts only the workspace and passes the limits', async () => {
	const { calls, runner } = recorder(async (_b, args, io) => {
		if (args.includes('run')) { io.stdout?.(write('x'.repeat((1 << 20) + 10))); io.stderr?.(write('warn')); return 7; }
		return 0;
	});
	const box = new Sandbox(new Runtime(containerd, runner), 'alpine:3.20', settings({ network: 'none', cpus: 1, memory: '512m' }), temp());
	const r = await box.exec(conversation, 'echo test', 1000);
	expect(r).toEqual({ exitCode: 7, stdout: 'x'.repeat(1 << 20), stderr: 'warn', truncated: true });
	const runCall = calls.find(c => c.includes('run'))!;
	expect(runCall).toContain('--network');
	expect(runCall).toContain('none');
	expect(runCall).toContain('--cpus');
	expect(runCall).toContain('1');
	expect(runCall).toContain('--memory');
	expect(runCall).toContain('512m');
	expect(runCall).toContain('-v');
	expect(runCall).toContain(`${box.workspace(conversation)}:${workdir}`);
});

test('an image already present runs even when the registry cannot be reached', async () => {
	const { runner } = recorder(async (_b, args, io) => {
		if (args.includes('pull')) { io.stderr?.(write('429 Too Many Requests')); return 1; }
		return 0;
	});
	const box = new Sandbox(new Runtime(containerd, runner), 'alpine:3.20', settings(), temp());
	expect((await box.exec(conversation, 'ls', 1000)).exitCode).toBe(0);
});

test('save writes into the workspace and never through a link', async () => {
	const box = Sandbox.create(settings(), temp())!;
	expect(await box.save(conversation, 'out.txt', 'whole output')).toBe(workdir + '/.mob/outputs/out.txt');
	const outputs = join(box.root, conversation, '.mob', 'outputs');
	expect(readFileSync(join(outputs, 'out.txt'), 'utf8')).toBe('whole output');
	for (const name of ['', '../x', 'a/b', '.hidden']) expect(box.save(conversation, name, 'x')).rejects.toThrow('invalid file name');

	// Commands may replace a file in outputs with a link; the host file must not be created.
	const outside = temp(), host = join(outside, 'host.txt');
	symlinkSync(host, join(outputs, 'link.txt'));
	expect(box.save(conversation, 'link.txt', 'overwritten')).rejects.toThrow();
	expect(existsSync(host)).toBe(false);

	// Commands may replace .mob/outputs with a link.
	const other = '0123456789abcdef0123456789abcde0';
	mkdirSync(join(box.root, other, '.mob'), { recursive: true });
	symlinkSync(outside, join(box.root, other, '.mob', 'outputs'));
	expect(box.save(other, 'new.txt', 'x')).rejects.toThrow('not a directory');
	expect(existsSync(join(outside, 'new.txt'))).toBe(false);

	// Commands may replace .mob itself with a link.
	const third = '0123456789abcdef0123456789abcde1';
	mkdirSync(join(box.root, third), { recursive: true });
	symlinkSync(outside, join(box.root, third, '.mob'));
	expect(box.save(third, 'new.txt', 'x')).rejects.toThrow('not a directory');
	expect(existsSync(join(outside, 'new.txt'))).toBe(false);
	expect(existsSync(join(outside, 'outputs'))).toBe(false);
});
