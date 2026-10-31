// mob runner connects this Mob to the web with end-to-end encryption.
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commands } from '../commands';
import { writeAtomic } from '../files';
import { credentials as local, reachable, start } from '../local';
import { validRelayKey } from '@mob/core/relay';
import { localHandler, origin, run, type Credentials } from './relay';

type Pairing = { url?: string; id?: string; code?: string; key?: string };


/**
 * deployed reads the credentials of a runner deployed without a terminal, such as on Render.
 * Its disk may not survive a restart, so the variable holds the credential itself, not a one-time code.
 */
export function deployed(raw: string): Credentials {
	let c: Credentials;
	try { c = JSON.parse(raw); } catch { throw new Error('invalid pairing JSON'); }
	if (!c || typeof c !== 'object') throw new Error('invalid pairing JSON');
	const url = origin(String(c.url ?? ''));
	if (!validRelayKey(c.key) || c.id?.length !== 36 || c.token?.length !== 72) throw new Error('invalid runner credentials; create a new Render pairing in the browser');
	return { url, id: c.id, token: c.token, key: c.key };
}

/** pair claims the pairing JSON's one-time code and saves the runner's credentials in dir. */
export async function pair(dir: string, input: string, signal?: AbortSignal) {
	if (input.length > 4096) throw new Error('invalid pairing JSON');
	let p: Pairing;
	try { p = JSON.parse(input); } catch { throw new Error('invalid pairing JSON'); }
	if (!p || typeof p !== 'object') throw new Error('invalid pairing JSON');
	const url = origin(String(p.url ?? ''));
	if (!validRelayKey(p.key) || p.id?.length !== 36 || p.code?.length !== 72) throw new Error('invalid pairing data');
	// Only the one-time code is sent to the server. The encryption key stays on this machine.
	let res: Response;
	try {
		res = await fetch(url + '/api/runners/claim', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: p.code }), redirect: 'manual',
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		});
	} catch { throw new Error('could not reach pairing service'); }
	if (res.status !== 200) throw new Error(`pairing failed (HTTP ${res.status}); create a new code in the browser`);
	const text = await res.text();
	let claimed: Partial<Credentials>;
	try { claimed = JSON.parse(text.slice(0, 4096)); } catch { throw new Error('invalid pairing response'); }
	// The cloud cannot replace the locally supplied key or origin in its response.
	if (claimed?.id !== p.id || claimed.token?.length !== 72) throw new Error('pairing response does not match this runner');
	const c: Credentials = { url, id: p.id!, token: claimed.token, key: p.key! };
	writeAtomic(join(dir, 'runner.json'), JSON.stringify(c));
}

/** stayAwake requests url every 10 minutes: the request reaches the host from outside, which the runner's own outbound connection does not. */
function stayAwake(url: string, signal: AbortSignal) {
	const timer = setInterval(() => { fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }).then(r => r.body?.cancel(), () => {}); }, 10 * 60_000);
	signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}

async function stdin() {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
		size += (chunk as Buffer).length;
		if (size > 4096 || (chunk as Buffer).includes(10)) break;
	}
	return Buffer.concat(chunks).toString('utf8').trim();
}

commands.push(environment => {
	const out = (line: string) => process.stdout.write(line + '\n');
	const command = new Command('runner').description('Connect this Mob to the web with end-to-end encryption')
		.option('--serve', 'Run Mob in this process too, for a machine that only runs the runner')
		.option('--health-addr <addr>', 'Answer health checks on this address, such as :10000; it serves nothing else')
		.option('--keep-awake <url>', 'Request this URL every 10 minutes, so a host that sleeps without inbound requests keeps the runner on')
		.action(async (o: { serve?: boolean; healthAddr?: string; keepAwake?: string }) => {
			const c = environment();
			let creds: Credentials;
			const env = process.env.MOB_RUNNER_PAIRING;
			if (env) {
				try { creds = deployed(env); } catch (e) { throw new Error('MOB_RUNNER_PAIRING: ' + (e as Error).message); }
			} else {
				let raw: string;
				try { raw = readFileSync(join(c.dir, 'runner.json'), 'utf8'); } catch (e) { throw new Error('pair this browser first with mob runner pair: ' + (e as Error).message); }
				creds = JSON.parse(raw);
			}
			const abort = new AbortController();
			process.once('SIGINT', () => abort.abort());
			process.once('SIGTERM', () => abort.abort());
			let health: ReturnType<typeof Bun.serve> | undefined;
			if (o.healthAddr) {
				// Hosts such as Render want a web service to answer on a port. It says only that the process runs; Mob itself stays on loopback.
				const at = o.healthAddr.lastIndexOf(':');
				health = Bun.serve({ hostname: o.healthAddr.slice(0, at) || '0.0.0.0', port: Number(o.healthAddr.slice(at + 1)), fetch: () => new Response('ok\n') });
			}
			if (o.keepAwake) stayAwake(o.keepAwake, abort.signal);
			let stopped = false;
			let connection;
			let app: Awaited<ReturnType<typeof start>> | undefined;
			if (!o.serve) {
				connection = local(c);
				if (!await reachable(connection)) throw new Error('Mob is not running; start it with mob start, or run mob runner --serve');
			} else {
				app = await start(c);
				connection = app.connection;
				out('Mob: ' + connection.url);
				app.done.then(() => { stopped = true; abort.abort(); });
			}
			try {
				await run(creds, localHandler(connection.url, connection.token), out, abort.signal);
			} finally {
				health?.stop(true);
				await app?.close();
			}
			if (stopped) throw new Error('Mob stopped');
			process.exit(0);
		});
	command.command('pair').description("Read the web pairing JSON from stdin and save this runner's credentials").action(async () => {
		process.stderr.write('Paste the pairing JSON from your signed-in web browser, then press Enter:\n');
		await pair(environment().dir, await stdin());
		out('Paired. Run mob start, then mob runner. Keep mob runner running for remote access.');
		process.exit(0);
	});
	return command;
});
