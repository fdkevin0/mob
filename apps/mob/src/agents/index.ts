// The coding agents plugin: tasks handed to outside coding agents, the tools
// and commands that manage them, and the tree the API shows.
import { z } from 'zod';
import { body, CommandError, type Plugin } from '@mob/core';
import { blueprints, steps } from './blueprints';
import { hostPlugins } from '../local';
import { snapshot } from './review';
import { Service } from './service';
import { commands, tools } from './tools';

const projectChange = z.discriminatedUnion('action', [
	z.object({ action: z.literal('add'), name: z.string(), path: z.string() }).strict(),
	z.object({ action: z.literal('remove'), name: z.string() }).strict(),
	z.object({ action: z.literal('save'), name: z.string(), path: z.string().optional(), blueprint: z.string(), checks: z.array(z.string().refine((c: string) => c.trim().length > 0)) }).strict(),
]);

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
				const parsed = projectChange.safeParse(await body(req, 64 << 10, ['action', 'name', 'path', 'blueprint', 'checks']));
				if (!parsed.success) throw new CommandError(400, 'invalid project change');
				const input = parsed.data;
				try {
					if (input.action === 'add') {
						const existing = svc.projects();
						const project = await svc.addProject(input.path, input.name);
						if (existing.some(p => p.name === project.name)) throw new Error(`Project ${project.name} already exists at ${project.path}.`);
						return project;
					}
					if (input.action === 'remove') { svc.removeProject(input.name); return { removed: true }; }
					return svc.setProject(input.name, { blueprint: input.blueprint, checks: input.checks });
				} catch (e) { throw new CommandError(400, (e as Error).message); }
			} },
		], commands: commands(svc), tools: tools(svc),
		hooks: { beforeTurn: [turn => snapshot(svc, turn)] },
		background: { name: 'agents', start: () => signal => new Promise<void>(resolve => signal.addEventListener('abort', () => void svc.shutdown().then(resolve), { once: true })) },
	};
}
