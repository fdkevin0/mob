// The sandbox plugin: configuration checks, the sandbox later turns use, and mob container.
import type { Environment } from '../config';
import type { HostPlugin } from '../local';
import type { Server } from '@mob/core';
import { containerCommand } from './command';
import { Sandbox, validateSandbox } from './sandbox';

const applied = new WeakMap<Server, { settings: string; box?: Sandbox }>();

/** sandboxOf is the sandbox a service's turns use, if one is on. */
export const sandboxOf = (server: Server) => applied.get(server)?.box;

/** apply gives later turns the sandbox the settings describe; a disabled one withdraws the tool. */
function apply(e: Environment, server: Server) {
	const settings = JSON.stringify(e.sandbox);
	if (applied.get(server)?.settings === settings) return;
	const box = Sandbox.create(e.sandbox, e.dir);
	applied.set(server, { settings, box });
	server.setSandbox(box);
	// An enabled sandbox that cannot run is logged; the model is told why when it tries.
	box?.runtime.check(AbortSignal.timeout(30_000)).catch(err => console.error('Sandbox enabled but not ready: ' + (err as Error).message));
}

export const sandboxPlugin: HostPlugin = {
	validate: e => validateSandbox(e.sandbox),
	command: containerCommand,
	attach(e, server) {
		const run = (next: Environment) => apply(next, server);
		run(e);
		return { reload: run };
	},
};
