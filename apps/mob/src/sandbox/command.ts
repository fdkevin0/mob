// mob container runs containers with the platform's runtime.
import { Command } from 'commander';
import type { Environment } from '../config';
import { Runtime, parseMemory, type Spec } from './container';

export function containerCommand(environment: () => Environment): Command {
	const root = new Command('container').description("Run containers with the platform's runtime (containerd, Apple container, WSL containers)");
	const open = () => Runtime.open(environment().sandbox.runtime);
	root.command('status').description('Show which container runtime is used and whether it is running').action(async () => {
		const r = open();
		console.log(`Container runtime: ${r.name} (${r.binary})`);
		await r.check();
		console.log('Ready.');
	});
	root.command('pull <image>').description('Fetch an image').action((image: string) => open().pull(image));
	const collect = (v: string, all: string[] = []) => [...all, v];
	root.command('run <image> [command...]').description('Run a command in a new container, removed when it exits; put -- before a command that takes options')
		.option('-e, --env <KEY=VALUE>', 'Set an environment variable (repeatable)', collect)
		.option('-v, --volume <SOURCE:TARGET>', 'Bind a host path (repeatable)', collect)
		.option('-w, --workdir <dir>', 'Working directory inside the container')
		.option('-i, --interactive', 'Pass standard input to the container')
		.option('--network <network>', '"none" to give the container no network')
		.option('--cpus <n>', 'Limit the container to this many whole CPUs', v => Number.parseInt(v, 10))
		.option('-m, --memory <size>', "Limit the container's memory, such as 512m or 2g")
		.option('--isolation <isolation>', '"gvisor" to run under gVisor (containerd only)')
		.action(async (image: string, command: string[], o: { env?: string[]; volume?: string[]; workdir?: string; interactive?: boolean; network?: string; cpus?: number; memory?: string; isolation?: string }) => {
			const spec: Spec = { image, command, env: o.env, workdir: o.workdir, limits: { network: o.network, cpus: o.cpus, memoryMiB: o.memory ? parseMemory(o.memory) : undefined }, isolation: o.isolation, stdin: o.interactive, mounts: [] };
			for (const v of o.volume ?? []) {
				const i = v.lastIndexOf(':');
				if (i <= 0) throw new Error(`volume "${v}" must be SOURCE:TARGET`);
				spec.mounts!.push({ source: v.slice(0, i), target: v.slice(i + 1) });
			}
			const code = await open().stream(spec, { stdin: o.interactive ? process.stdin : undefined, stdout: c => process.stdout.write(c), stderr: c => process.stderr.write(c) });
			if (code !== 0) throw new Error(`container exited with status ${code}`);
		});
	return root;
}
