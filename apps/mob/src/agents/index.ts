// The coding agents plugin: tasks handed to outside coding agents, the tools
// and commands that manage them, and the tree the API shows.
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
	return [{
		name: 'agents', commands: commands(svc), tools: tools(svc),
		hooks: { beforeTurn: [turn => snapshot(svc, turn)] },
		background: { name: 'agents', start: () => signal => new Promise<void>(resolve => signal.addEventListener('abort', () => void svc.shutdown().then(resolve), { once: true })) },
	}];
});
