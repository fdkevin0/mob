// The GitHub plugin: events of the Mob GitHub App, which the runner hands
// over from usemob.app (see watch.ts).
import { body, CommandError, type Plugin } from '@mob/core';
import { sleep } from '@mob/core/sleep';
import { hostPlugins } from '../local';
import { runnerCredentials } from '../runner';
import { GitHub } from './client';
import { Watcher } from './watch';

hostPlugins.push((e, server) => [githubPlugin(new Watcher(server.options.store, server, new GitHub(() => runnerCredentials(e.dir))))]);

export function githubPlugin(w: Watcher): Plugin {
	return {
		name: 'github',
		routes: [{
			// The runner posts here; the relay refuses it to browsers (runner/relay.ts).
			method: 'POST', path: 'events', handle: async req => {
				const input = await body<{ events?: unknown }>(req, 1 << 20, ['events']);
				if (!Array.isArray(input.events) || input.events.length > 50) throw new CommandError(400, 'events must be a list of up to 50');
				return { accepted: w.receive(input.events) };
			},
		}],
		// Saved events wait in Mob's database: this runs them after a restart, and retries the ones that failed when they are due.
		background: { name: 'github', start: () => async signal => {
			while (!signal.aborted) {
				await w.work().catch(err => console.error('github:', err));
				const due = w.due();
				await sleep(due === undefined ? 60_000 : Math.min(60_000, Math.max(1_000, due - Date.now())), signal).catch(() => {});
			}
		} },
	};
}
