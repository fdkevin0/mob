#!/usr/bin/env bun
// mob: the local assistant's command line.
import { Command, Option } from 'commander';
import { join } from 'node:path';
import { Loader, envOf, flagOf, options, type Environment } from './config';
import { credentials, pairingURL, reachable, rotateToken, start, startBackground, status, stopBackground, webURL } from './local';
import { providerCommand } from './provider-command';
import { readProviders } from './providers';
import { version } from './version';
import { validateProviders } from '@mob/core';
import { commands } from './commands';
import './plugins';

const program = new Command('mob').description('Local assistant with desktop, terminal and background service').version(version).showHelpAfterError();

const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
for (const o of options) {
	const value = typeof o.value === 'function' ? undefined : o.value;
	const flag = flagOf(o);
	const option = typeof value === 'boolean' ? new Option(`--${flag} [bool]`, `${o.help} (${envOf(o)})`) : new Option(`--${flag} <value>`, `${o.help} (${envOf(o)})`);
	if (typeof value === 'number') option.argParser(v => { if (!/^-?\d+$/.test(v)) throw new Error(`--${flag} takes an integer`); return Number(v); });
	if (typeof value === 'boolean') option.argParser(v => v === undefined || v === 'true' || v === '1');
	program.addOption(option);
}

/** environment reads the configuration with the flags given explicitly. */
function environment(): Environment {
	const flags: Record<string, string | boolean | number> = {};
	const given = program.opts();
	for (const o of options) {
		const key = camel(flagOf(o));
		if (program.getOptionValueSource(key) === 'cli') flags[o.key] = given[key] === undefined ? true : given[key];
	}
	return new Loader(flags).read();
}

const out = (line: string) => process.stdout.write(line + '\n');

async function serve(background: boolean) {
	const c = environment();
	const app = await start(c, background);
	out(`Mob: ${app.connection.url}\nDemo mode: ${c.demo}\nConfiguration: ${c.loader.path}`);
	out(c.token ? 'Access token: supplied through configuration' : `Token file: ${join(c.dir, 'token')}`);
	const signals = new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
	await Promise.race([signals, app.done]);
	await app.close();
	process.exit(0);
}

program.action(() => serve(false));
program.command('serve').description('Run the service until interrupted').option('--background', 'Mark this process as managed by mob start/stop').action((o: { background?: boolean }) => serve(!!o.background));
program.command('start').description('Start an independent background service').action(async () => {
	await startBackground(environment());
	out('Mob is running in the background. GUI and TUI can close without stopping plugins.');
});
program.command('status').description('Show service and configuration reload status').action(async () => {
	const s = await status(environment());
	out(`Mob running · background: ${s.background}`);
	if (s.configError) out('Configuration reload: ' + s.configError);
});
program.command('stop').description('Stop the background service').action(async () => {
	await stopBackground(environment());
	out('Mob stopped.');
});
program.command('connection').description('Start the background service if needed and print its URL and token as JSON').action(async () => {
	// The desktop app reads this; it never parses Mob's files itself.
	const c = environment();
	let connection;
	try { connection = credentials(c); } catch { /* not started yet */ }
	if (!connection || !await reachable(connection)) {
		await startBackground(c);
		connection = credentials(c);
	}
	out(JSON.stringify(connection));
});
program.command('tui').description('Open the terminal UI').action(async () => {
	const c = environment();
	let connection;
	try { connection = credentials(c); } catch { /* not started yet */ }
	if (!connection || !await reachable(connection)) {
		await startBackground(c);
		connection = credentials(c);
	}
	const { run } = await import('@mob/tui/run');
	await run(connection);
});
program.command('token').description('Manage the local access token').command('rotate').description('Replace the local access token and sign out every client').action(async () => {
	const c = environment();
	await rotateToken(c);
	out(`Access token replaced: ${join(c.dir, 'token')}\nSigned-in browsers, terminals and desktop windows must sign in again; run mob open for a browser.`);
});
program.command('open').description('Sign a browser in to the running service with a one-time link')
	.option('--print', 'Print the link without opening a browser')
	.option('--web', 'Open the public web UI (web_url) instead of the page this service serves')
	.action(async (o: { print?: boolean; web?: boolean }) => {
		const c = environment();
		const link = o.web ? await webURL(c) : await pairingURL(c);
		out(`Open this link within 5 minutes; it works once:\n${link}`);
		if (!o.print) openBrowser(link);
	});
program.command('config').description('Inspect configuration without exposing secrets').command('check').description('Validate configuration and show its location').action(() => {
	const c = environment();
	const f = readProviders(c.loader.providersPath);
	if (f) validateProviders(f);
	out(`Configuration valid: ${c.loader.path}\nProviders: ${c.loader.providersPath}\nData directory: ${c.dir}\nState directory: ${c.stateDir}`);
});
program.addCommand(providerCommand(() => environment().loader.providersPath));
for (const add of commands) program.addCommand(add(environment));

function openBrowser(url: string) {
	const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
	try { Bun.spawn(command, { stdio: ['ignore', 'ignore', 'ignore'] }).unref(); } catch { /* print only */ }
}

program.parseAsync().catch(e => {
	process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
	process.exit(1);
});
