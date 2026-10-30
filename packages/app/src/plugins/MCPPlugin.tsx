import { useEffect, useState } from 'react';
import { api, type Connection } from '../api';
import type { MCPOverview } from '../contracts';
import { Button } from '@mob/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { Notice } from '@mob/ui/notice';
import { Field, Feedback, errorText } from './shared';

export function MCPPlugin({ connection }: { connection: Connection }) {
  const [data, setData] = useState<MCPOverview>();
  const [view, setView] = useState<'installed' | 'discover'>('installed');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MCPOverview['catalog'][number]>();
  const [removing, setRemoving] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() { setData(await api<MCPOverview>(connection, '/plugins/mcp/overview')); }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    const refresh = () => { if (!document.hidden) void api<MCPOverview>(connection, '/plugins/mcp/overview').then(d => { if (active) setData(d); }, e => { if (active) setError(errorText(e)); }); };
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [connection]);
  return <section aria-label="MCP market" className="extension-market"><h2>MCP servers</h2>
    <p>Connect external tools to the current Mob service. Installing a server does not approve its tool calls.</p>
    <div className="plugin-actions"><Button variant={view === 'installed' ? 'primary' : 'outline'} aria-pressed={view === 'installed'} onClick={() => setView('installed')}>Installed</Button><Button variant={view === 'discover' ? 'primary' : 'outline'} aria-pressed={view === 'discover'} onClick={() => setView('discover')}>Discover</Button><Button variant="ghost" disabled={busy} onClick={() => void perform(load)}>Refresh</Button></div>
    <Feedback error={selected || removing ? '' : error} notice={notice} /><Field label="Search MCP servers" value={query} onChange={setQuery} />
    {!data && !error && <p role="status">Loading servers…</p>}
    {view === 'installed' ? <>
      {data?.servers.length === 0 && <p>No servers installed. Open Discover to connect one.</p>}
      {data?.servers.filter(s => s.name.toLowerCase().includes(query.toLowerCase())).map(s => <article className="extension-row" key={s.name}>
        <h3>{s.name}</h3><p>{s.shadowed ? 'Installation overridden by config.yaml' : s.managed ? 'Installed by Mob' : 'Managed by config.yaml'}</p><p role="status">{s.connected ? 'Connected' : s.status}</p>
        {s.signInUrl && /^https?:\/\//.test(s.signInUrl) && <a href={s.signInUrl} target="_blank" rel="noreferrer">Sign in to connect</a>}
        <details><summary>{s.tools.length} tools{s.connected ? '' : ' (unavailable until connected)'}</summary>{s.tools.map(t => <div key={t.name}><h4>{t.name} ({t.exposure})</h4><p>{t.description}</p></div>)}</details>
        {s.managed && <Button variant="ghost" disabled={busy} onClick={() => setRemoving(s.name)}>Remove installation</Button>}
      </article>)}
      {data?.servers.some(s => s.signInUrl) && <form onSubmit={e => { e.preventDefault(); void perform(async () => { await api(connection, '/plugins/mcp/signin', { address }); setAddress(''); await load(); setNotice('Sign-in received. Connecting…'); }); }}><Field label="Finish sign-in from another device" hint="If the final localhost page cannot open, paste its full address here." value={address} onChange={setAddress} /><Button disabled={busy || !address}>Finish sign-in</Button></form>}
    </> : <>
      <p>Remote HTTP servers from Mob’s selections and your configured registry namespaces.</p>
      {data?.catalog.filter(s => `${s.title ?? s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase())).map(s => <article className="extension-row" key={s.url}><h3>{s.title ?? s.name}</h3><p>{s.description}</p><p>{s.source}</p><Button variant="outline" disabled={busy} onClick={() => setSelected(s)}>View details</Button></article>)}
      {data?.catalog.length === 0 && <p>No additional servers available in the configured catalog.</p>}
    </>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open && !busy) { setSelected(undefined); setError(''); } }}><DialogContent className="extension-detail"><DialogTitle>{selected?.title ?? selected?.name}</DialogTitle><DialogDescription>Review this connection before installing it on the current Mob service.</DialogDescription><p>{selected?.description}</p><p>Source: {selected?.source}</p><p>Endpoint: {selected?.url}</p>{selected?.version && <p>Version: {selected.version}</p>}{selected?.repository && /^https:\/\//.test(selected.repository) && <a href={selected.repository} target="_blank" rel="noreferrer">Source repository</a>}{selected?.requiredHeader && <p>Requires {selected.requiredHeader}. Add this server and its credentials in config.yaml.</p>}{error && <Notice tone="error">{error}</Notice>}<Button disabled={busy || !!selected?.requiredHeader} onClick={() => void perform(async () => { const result = await api<{ name: string; error: string }>(connection, '/plugins/mcp/install', { url: selected!.url }); setSelected(undefined); setView('installed'); await load(); setNotice(result.error || 'Server installed. Check its connection and sign-in status below.'); })}>Install server</Button></DialogContent></Dialog>
    <Dialog open={!!removing} onOpenChange={open => { if (!open && !busy) { setRemoving(''); setError(''); } }}><DialogContent><DialogTitle>Remove {removing}?</DialogTitle><DialogDescription>The saved installation will be removed. Servers managed by config.yaml keep their configuration and sign-in.</DialogDescription>{error && <Notice tone="error">{error}</Notice>}<Button disabled={busy} onClick={() => void perform(async () => { await api(connection, '/plugins/mcp/remove', { name: removing }); setRemoving(''); await load(); })}>Remove installation</Button></DialogContent></Dialog>
  </section>;
}
