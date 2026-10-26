// The coding agents plugin: tasks handed to outside coding agents, the tools
// and commands that manage them, and the tree the API shows.
import { body, CommandError, type Plugin } from '@mob/core';
import { blueprints, steps } from './blueprints';
import { hostPlugins } from '../local';
import { snapshot } from './review';
import { Service } from './service';
import { commands, tools } from './tools';

hostPlugins.push((e, server) => {
	const svc = new Service(server.options.store, server, e.dir);
	// The agents of the tasks that were running ended with Mob.
	svc.recover();
	server.setDelegate(svc);
	server.tasks = svc;
	return [agentPlugin(svc)];
});

export function agentPlugin(svc: Service): Plugin {
	return {
		name: 'agents', routes: [
			{ method: 'GET', path: 'projects', handle: async () => ({ projects: svc.projects(), blueprints: blueprints.map(b => ({ name: b.name, title: b.title, description: steps(b) })) }) },
			{ method: 'POST', path: 'projects', handle: async req => {
				const input = await body<{ action?: unknown; name?: unknown; path?: unknown; blueprint?: unknown; checks?: unknown }>(req, 64 << 10, ['action', 'name', 'path', 'blueprint', 'checks']);
				if (typeof input.name !== 'string') throw new CommandError(400, 'name must be text');
				try {
					if (input.action === 'add' && typeof input.path === 'string') return await svc.addProject(input.path, input.name);
					if (input.action === 'remove') { svc.removeProject(input.name); return { removed: true }; }
					if (input.action === 'save' && typeof input.blueprint === 'string' && Array.isArray(input.checks) && input.checks.every(c => typeof c === 'string' && c.trim())) return svc.setProject(input.name, { blueprint: input.blueprint, checks: input.checks });
				} catch (e) { throw new CommandError(400, (e as Error).message); }
				throw new CommandError(400, 'invalid project change');
			} },
		], commands: commands(svc), tools: tools(svc),
		hooks: { beforeTurn: [turn => snapshot(svc, turn)] },
		background: { name: 'agents', start: () => signal => new Promise<void>(resolve => signal.addEventListener('abort', () => void svc.shutdown().then(resolve), { once: true })) },
	};
}
