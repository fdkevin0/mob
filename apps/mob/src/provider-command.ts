// mob provider edits providers.json directly; a running service reloads it.
import { Command } from 'commander';
import { ProviderRegistry, adoptDefault, destination, displayName, endpoint, findPreset, maskedKey, presets, validateProvider, type Provider } from '@mob/core';
import { fileCatalog, fileProviders } from './providers';
import { findMagpie } from './magpie';

/** needsKey reports whether requests need a key: local servers don't; a custom endpoint may not. */
const needsKey = (p: Provider) => { const pr = findPreset(p.preset); return !!pr && !pr.noKey; };

async function readLine(): Promise<string> {
	const reader = Bun.stdin.stream().getReader();
	let text = '';
	const decoder = new TextDecoder();
	for (;;) {
		const { value, done } = await reader.read();
		if (value) text += decoder.decode(value, { stream: true });
		if (done || text.includes('\n')) break;
	}
	reader.releaseLock();
	return text.split('\n')[0].trim();
}

/** readHidden reads a key from the terminal without echoing it. */
async function readHidden(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	process.stdin.setRawMode?.(true);
	let key = '';
	try {
		for await (const chunk of process.stdin) {
			for (const ch of String(chunk)) {
				if (ch === '\r' || ch === '\n') return key.trim();
				if (ch === '\u0003') process.exit(130);
				if (ch === '\u007f') key = key.slice(0, -1); else key += ch;
			}
		}
	} finally {
		process.stdin.setRawMode?.(false);
		process.stdout.write('\n');
	}
	return key.trim();
}

export function providerCommand(path: () => string): Command {
	const root = new Command('provider').alias('providers').description('Manage model providers (providers.json)');
	const open = () => new ProviderRegistry(fileProviders(path()), fileCatalog());
	const names = presets.map(p => p.id);
	root.command('add <id>').description('Add a provider, or update one already added')
		.addHelpText('after', `\nPresets: ${names.join(', ')}\nA preset's ID is enough: mob provider add deepseek --key-stdin\nmagpie finds the magpie gateway on this machine: mob provider add magpie\nAny other ID needs --chat or --anthropic: mob provider add work --chat https://relay.example/v1 --key-stdin\nOn a terminal the key is asked for when the provider needs one. Prefer --key-stdin to --key, which shell history keeps.`)
		.option('--preset <id>', 'Preset to start from (default: the ID, when it is one)')
		.option('--key-stdin', 'Read the API key from standard input')
		.option('--key <key>', 'API key (kept by shell history; prefer --key-stdin)')
		.option('--clear-key', 'Remove the saved key (needed when changing a URL without a new key)')
		.option('--clear-headers', 'Remove saved headers (needed when changing a URL that has them)')
		.option('--name <name>', 'Display name')
		.option('--chat <url>', 'OpenAI Chat Completions base URL, e.g. https://host/v1')
		.option('--anthropic <url>', 'Anthropic Messages base URL (without /v1)')
		.option('--models-url <url>', 'Model list URL, when not BASE/models')
		.option('--models <ids>', 'Models to offer, comma-separated (default: every model it lists)')
		.option('--default <model>', 'Also make this model the default')
		.option('--offline', 'Save without asking the provider for its model list')
		.action(async (rawID: string, o: Record<string, string | boolean | undefined>) => {
			const id = rawID.toLowerCase();
			const r = open();
			const existing = r.providers().providers.find(p => p.id === id);
			const p: Provider = existing ? structuredClone(existing) : { id };
			if (o.preset) p.preset = String(o.preset);
			else if (!existing && findPreset(id)) p.preset = id;
			if (o.name !== undefined) p.name = String(o.name).trim();
			if (o.chat !== undefined) p.chat = String(o.chat).trim();
			if (o.anthropic !== undefined) p.anthropic = String(o.anthropic).trim();
			if (o.modelsUrl !== undefined) p.modelsURL = String(o.modelsUrl).trim();
			// magpie's gateway listens on the port in its settings, which is looked up unless a URL was given.
			if (p.preset === 'magpie' && !o.offline && o.chat === undefined && o.anthropic === undefined) {
				let found;
				try { found = await findMagpie(); } catch (e) { throw new Error((e as Error).message + ' (or save it as is with --offline)'); }
				delete p.chat; delete p.anthropic;
				if (found.chat !== endpoint(p, 'chat')) { p.chat = found.chat; p.anthropic = found.anthropic; }
			}
			if (!p.preset && !p.chat && !p.anthropic) throw new Error(`"${id}" is not a preset (${names.join(', ')}); give its base URL with --chat or --anthropic`);
			// Credentials saved for one destination never follow the provider to another.
			if (o.clearKey) delete p.key;
			if (o.clearHeaders) delete p.headers;
			if (existing && destination(existing) !== destination(p)) {
				if (p.key && !o.keyStdin && o.key === undefined) throw new Error(`${id} now points elsewhere; give its key again with --key-stdin, or drop it with --clear-key`);
				if (p.headers && Object.keys(p.headers).length) throw new Error(`${id} now points elsewhere and has saved headers; drop them with --clear-headers`);
			}
			if (o.keyStdin) p.key = await readLine();
			else if (o.key !== undefined) p.key = String(o.key).trim();
			else if (!p.key && needsKey(p) && process.stdin.isTTY) {
				const pr = findPreset(p.preset);
				if (pr?.keysUrl) console.log('Create a key at ' + pr.keysUrl);
				p.key = await readHidden(`API key for ${id} (hidden): `);
			}
			if (!p.key) delete p.key;
			if (!p.key && needsKey(p)) throw new Error(`${id} needs an API key: mob provider add ${id} --key-stdin`);
			validateProvider(p);
			let listed: string[] = [];
			if (!o.offline) {
				try { listed = await r.fetch(p, AbortSignal.timeout(20_000)); } catch (e) {
					console.error(`Warning: ${(e as Error).message}. Saved anyway; check the key and URL.`);
				}
			}
			if (o.models !== undefined) {
				p.models = String(o.models).split(',').map(s => s.trim()).filter(Boolean);
				p.pickedFrom = listed;
			}
			r.update(f => {
				const i = f.providers.findIndex(q => q.id === id);
				if (i >= 0) f.providers[i] = p; else f.providers.push(p);
				if (o.default) f.default = id + '/' + String(o.default).replace(new RegExp('^' + id.replace(/[.]/g, '\\.') + '/'), '');
				else adoptDefault(f, p, listed);
			});
			console.log(`${existing ? 'Updated' : 'Added'} ${id} (${displayName(p)}) in ${path()}`);
			if (listed.length) console.log(`It lists ${listed.length} models, e.g. ${listed.slice(0, 5).join(', ')}`);
			console.log(`In a conversation: /models ${id}, then /model ${id}/MODEL`);
		});
	root.command('ls').alias('list').description('List providers').action(() => {
		const f = open().providers();
		console.log(`${path()}\nDefault model: ${f.default || '(none)'}\n`);
		const rows = [['ID', 'NAME', 'ENDPOINT', 'KEY', 'MODELS'], ...f.providers.map(p => [
			p.id, displayName(p), endpoint(p, 'chat') || endpoint(p, 'anthropic') + ' (anthropic)', maskedKey(p) || '-',
			(p.models?.length ? p.models.join(',') : 'all listed') + (p.off ? ' (off)' : ''),
		])];
		const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
		for (const row of rows) console.log(row.map((c, i) => (i < row.length - 1 ? c.padEnd(widths[i] + 2) : c)).join(''));
	});
	root.command('rm <id>').alias('remove').description('Remove a provider and its key').action((rawID: string) => {
		const id = rawID.toLowerCase();
		let cleared = false;
		open().update(f => {
			const n = f.providers.length;
			f.providers = f.providers.filter(p => p.id !== id);
			if (f.providers.length === n) throw new Error(`no provider "${id}"`);
			if (f.default?.startsWith(id + '/')) { delete f.default; cleared = true; }
		});
		console.log(`Removed ${id}. The previous file is kept as ${path()}.bak`);
		if (cleared) console.log('It held the default model; pick another with /model default NAME.');
	});
	return root;
}
