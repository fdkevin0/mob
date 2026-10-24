// The sandbox plugin: configuration checks, the sandbox later turns use, and mob container.
import { commands } from '../commands';
import { validators, type Environment } from '../config';
import { reloads, setups } from '../local';
import type { Server } from '@mob/core';
import { containerCommand } from './command';
import { Sandbox, validateSandbox } from './sandbox';

validators.push(e => validateSandbox(e.sandbox));
commands.push(containerCommand);

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

setups.push(apply);
reloads.push(apply);
