// The catalog of remote MCP servers the model may find and ask to install:
// Mob's own list, and what the MCP Registry lists for allowed namespaces.
import { glob } from './config';

/** defaultRegistry is the official MCP Registry. */
export const defaultRegistry = 'https://registry.modelcontextprotocol.io';

/** catalogKey is the setting that keeps what the registry last listed. */
export const catalogKey = 'mcp_catalog';
/** refreshAfter is how old the registry's listing may grow before Mob asks again. */
export const refreshAfter = 24 * 3600_000;
/** registryPages bounds the pages read for one namespace; maxListings what the catalog keeps. */
const registryPages = 20, maxListings = 500;

/** Registry is where the catalog finds remote servers besides Mob's own list. */
export type Registry = {
	url: string;
	/** namespaces are globs of registry names, such as com.cloudflare.mcp/*; without any Mob asks no registry. */
	namespaces: string[];
};

/** validateRegistry refuses a registry that is not an https URL, or a namespace that is not a glob of names. */
export function validateRegistry(r: Registry) {
	if (!r.namespaces.length) return;
	let u: URL | undefined;
	try { u = new URL(r.url); } catch { /* refused below */ }
	if (!u || u.protocol !== 'https:' || !u.host) throw new Error('mcp_registry.url must be an https URL');
	for (const g of r.namespaces) {
		let ok = g.includes('/');
		try { glob(g, ''); } catch { ok = false; }
		if (!ok) throw new Error(`mcp_registry.namespaces: ${JSON.stringify(g)} is not a glob of names such as com.example/*`);
	}
}

/** Listing is a remote server the model may find and ask to install. */
export type Listing = {
	/** name is the server's name in the registry, or Mob's for its own. */
	name: string;
	title?: string;
	description: string;
	version?: string;
	repository?: string;
	url: string;
	headers?: Header[];
	/** source is the registry it came from, or "mob" for Mob's own list. */
	source: string;
};

export type Header = { name: string; description?: string; required?: boolean; secret?: boolean };

/** curated are the servers every catalog offers. They sign in with OAuth. */
export const curated: Listing[] = [
	{ name: 'cloudflare', title: 'Cloudflare API', description: 'The whole Cloudflare API: search its endpoints, then run code against them, for DNS, Workers, R2, D1, zones and account settings.', url: 'https://mcp.cloudflare.com/mcp', source: 'mob' },
	{ name: 'cloudflare-docs', title: 'Cloudflare documentation', description: "Search Cloudflare's developer documentation.", url: 'https://docs.mcp.cloudflare.com/mcp', repository: 'https://github.com/cloudflare/mcp-server-cloudflare', source: 'mob' },
	{ name: 'cloudflare-browser', title: 'Cloudflare Browser Rendering', description: "Fetch web pages as Markdown or HTML and take screenshots with Cloudflare's headless browsers.", url: 'https://browser.mcp.cloudflare.com/mcp', repository: 'https://github.com/cloudflare/mcp-server-cloudflare', source: 'mob' },
	{ name: 'cloudflare-radar', title: 'Cloudflare Radar', description: 'Internet traffic trends, outages, attacks and domain rankings from Cloudflare Radar.', url: 'https://radar.mcp.cloudflare.com/mcp', repository: 'https://github.com/cloudflare/mcp-server-cloudflare', source: 'mob' },
];

/** Catalog is what the registry last listed for the namespaces asked. */
export type Catalog = { registry: Registry; synced: string; listings: Listing[] };

export const sameRegistry = (a: Registry, b: Registry) => a.url === b.url && a.namespaces.join('\n') === b.namespaces.join('\n');

/** needs is the header a listing requires, if any: Mob cannot ask the model for its value, so the owner configures such a server. */
export const needs = (l: Listing) => l.headers?.find(h => h.required)?.name ?? '';

type RegistryPage = {
	servers?: {
		server?: { name?: string; title?: string; description?: string; version?: string; status?: string; repository?: { url?: string };
			remotes?: { type?: string; url?: string; headers?: { name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }[] }[] };
		_meta?: { 'io.modelcontextprotocol.registry/official'?: { status?: string } };
	}[];
	metadata?: { nextCursor?: string };
};

/**
 * fetchRegistry lists the remote servers whose names match the registry's
 * namespaces: the latest version of each active server, one listing for each
 * of its Streamable HTTP endpoints served over https.
 */
export async function fetchRegistry(r: Registry, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Listing[]> {
	const list: Listing[] = [];
	const seen = new Set<string>();
	for (const g of r.namespaces) {
		// The registry searches names by substring: the glob's literal start.
		const prefix = g.slice(0, (g + '*').search(/[*?[\\]/));
		let cursor = '';
		for (let page = 0; page < registryPages; page++) {
			const query = new URLSearchParams({ search: prefix, version: 'latest', limit: '100' });
			if (cursor) query.set('cursor', cursor);
			const res = await fetcher(`${r.url.replace(/\/$/, '')}/v0.1/servers?${query}`, { headers: { Accept: 'application/json' }, signal });
			if (res.status !== 200) throw new Error(`the registry answered ${res.status} ${res.statusText}`);
			const text = await res.text();
			if (text.length > 8 << 20) throw new Error('the registry answered too much');
			const data = JSON.parse(text) as RegistryPage;
			for (const entry of data.servers ?? []) {
				const s = entry.server ?? {};
				const status = entry._meta?.['io.modelcontextprotocol.registry/official']?.status || s.status || '';
				let match = false;
				try { match = glob(g, s.name ?? ''); } catch { /* validated */ }
				if (!match || (status && status !== 'active')) continue;
				for (const remote of s.remotes ?? []) {
					let u: URL | undefined;
					try { u = new URL(remote.url ?? ''); } catch { /* skipped */ }
					if (remote.type !== 'streamable-http' || !u || u.protocol !== 'https:' || !u.host || seen.has(remote.url!)) continue;
					seen.add(remote.url!);
					const l: Listing = { name: s.name!, title: s.title || undefined, description: s.description ?? '', version: s.version || undefined, repository: s.repository?.url || undefined, url: remote.url!, source: r.url };
					if (remote.headers?.length) l.headers = remote.headers.map(h => ({ name: h.name ?? '', description: h.description || undefined, required: h.isRequired || undefined, secret: h.isSecret || undefined }));
					list.push(l);
					if (list.length === maxListings) return list;
				}
			}
			cursor = data.metadata?.nextCursor ?? '';
			if (!cursor) break;
		}
	}
	return list;
}

export function hostOf(raw: string) {
	try { return new URL(raw).host; } catch { return raw; }
}
