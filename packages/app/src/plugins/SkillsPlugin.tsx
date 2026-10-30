import { useEffect, useState } from 'react';
import { api, type Connection } from '../api';
import type { SkillPreview, SkillsOverview } from '../contracts';
import { Button } from '@mob/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { Notice } from '@mob/ui/notice';
import { Field, Feedback, errorText } from './shared';

const curated = [
  { name: 'Frontend design', source: 'anthropics/skills', skillPath: 'skills/frontend-design/SKILL.md', description: 'Build intentional web interfaces.' },
  { name: 'React best practices', source: 'vercel-labs/agent-skills', skillPath: 'skills/react-best-practices/SKILL.md', description: 'Review and improve React performance.' },
];

export function SkillsPlugin({ connection }: { connection: Connection }) {
  const [data, setData] = useState<SkillsOverview>();
  const [view, setView] = useState<'installed' | 'discover'>('installed');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [ref, setRef] = useState('');
  const [skillPath, setPath] = useState('SKILL.md');
  const [paths, setPaths] = useState<string[]>();
  const [preview, setPreview] = useState<SkillPreview>();
  const [reading, setReading] = useState<{ name: string; content: string }>();
  const [removing, setRemoving] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() { setData(await api<SkillsOverview>(connection, '/plugins/skills/installed')); }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void api<SkillsOverview>(connection, '/plugins/skills/installed').then(d => { if (active) setData(d); }, e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [connection]);
  return <section aria-label="Skills market" className="extension-market">
    <h2>Skills</h2>
    <p>Instructions and supporting files for your assistant. Installs go to the connected Mob service. Shared skills stay managed by their original installer.</p>
    <div className="plugin-actions">
      <Button variant={view === 'installed' ? 'primary' : 'outline'} aria-pressed={view === 'installed'} onClick={() => setView('installed')}>Installed</Button>
      <Button variant={view === 'discover' ? 'primary' : 'outline'} aria-pressed={view === 'discover'} onClick={() => setView('discover')}>Discover</Button>
      <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { setData(await api<SkillsOverview>(connection, '/plugins/skills/check', {})); setNotice('Update check finished. Installed files are unchanged.'); })}>Check for updates</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void perform(load)}>Refresh</Button>
    </div>
    <Feedback error={preview || reading || removing ? '' : error} notice={notice} />
    {busy && <p role="status">Working…</p>}
    <Field label="Search skills" value={query} onChange={setQuery} />
    {view === 'installed' ? <>
      {!data && !error && <p role="status">Loading skills…</p>}
      {data?.warnings.map(w => <Notice tone="warning" key={w}>{w}</Notice>)}
      {data?.skills.length === 0 && <p>No skills installed. Open Discover to preview and install one.</p>}
      {data?.skills.filter(s => `${s.name} ${s.description} ${s.source ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(s => <article className="extension-row" key={s.name}>
        <h3>{s.name}</h3><p>{s.description}</p>
        <p>{s.managed ? 'Installed by Mob' : 'Externally managed'}{s.source && ` · ${s.source}`}{s.ref && ` · ${s.ref}`}</p>
        {s.compatibility && <p>Compatibility: {s.compatibility}</p>}
        {s.update && <p role="status" data-update={s.update.status}>{s.update.message}</p>}
        <div className="plugin-actions"><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { setReading({ name: s.name, ...await api<{ content: string }>(connection, '/plugins/skills/read', { name: s.name }) }); })}>View instructions</Button>
          {s.managed && <Button variant="ghost" disabled={busy} onClick={() => setRemoving(s.name)}>Remove</Button>}</div>
      </article>)}
    </> : <>
      {curated.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase())).map(s => <article className="extension-row" key={s.source}>
        <h3>{s.name}</h3><p>{s.description}</p><p>{s.source}</p>
        <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { setPreview(await api<SkillPreview>(connection, '/plugins/skills/preview', { source: s.source, skillPath: s.skillPath })); })}>Preview</Button>
      </article>)}
      <h3>Install from GitHub</h3>
      <form onSubmit={e => { e.preventDefault(); void perform(async () => { setPreview(await api<SkillPreview>(connection, '/plugins/skills/preview', { source: source.trim(), ref: ref.trim() || undefined, skillPath: skillPath.trim() })); }); }}>
        <fieldset disabled={busy}><Field label="Repository (owner/repo)" value={source} onChange={value => { setSource(value); setPaths(undefined); }} /><Field label="Branch or tag (optional)" value={ref} onChange={value => { setRef(value); setPaths(undefined); }} />
          <Button type="button" variant="outline" disabled={!source} onClick={() => void perform(async () => { setPaths(await api<string[]>(connection, '/plugins/skills/discover', { source: source.trim(), ref: ref.trim() || undefined })); })}>Find skills in repository</Button>
          {paths && <label className="plugin-field">Skills in repository<select value={paths.includes(skillPath) ? skillPath : ''} onChange={e => setPath(e.target.value)}><option value="" disabled>{paths.length ? 'Choose a skill' : 'No SKILL.md files found'}</option>{paths.map(path => <option key={path} value={path}>{path}</option>)}</select></label>}
          <Field label="Path to SKILL.md" value={skillPath} onChange={setPath} /><Button disabled={!source}>Preview skill</Button></fieldset>
      </form>
    </>}
    <Dialog open={!!preview || !!reading} onOpenChange={open => { if (!open && !busy) { setPreview(undefined); setReading(undefined); setError(''); } }}>
      <DialogContent className="extension-detail"><DialogTitle>{preview?.name ?? reading?.name}</DialogTitle><DialogDescription>{preview ? `Review before installing from ${preview.source} on the connected Mob service.` : 'Installed skill instructions.'}</DialogDescription>
        {preview && <><p>Revision: {preview.commit.slice(0, 12)}</p><p>{preview.files.length} files. Scripts run only through Mob’s sandbox; other agent-specific tools may not be available.</p><details><summary>Files</summary><pre>{preview.files.join('\n')}</pre></details></>}
        <pre className="plugin-result">{preview?.content ?? reading?.content}</pre>
        {error && <Notice tone="error">{error}</Notice>}
        {preview && <Button disabled={busy} onClick={() => void perform(async () => { await api(connection, '/plugins/skills/install', { source: preview.source, ref: preview.ref, skillPath: preview.skillPath, commit: preview.commit }); setPreview(undefined); setView('installed'); await load(); setNotice('Skill installed. Available from the next turn.'); })}>{busy ? 'Installing…' : 'Install skill'}</Button>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!removing} onOpenChange={open => { if (!open && !busy) { setRemoving(''); setError(''); } }}><DialogContent><DialogTitle>Remove {removing}?</DialogTitle><DialogDescription>This deletes the skill installed by Mob, including any edits to its files.</DialogDescription>{error && <Notice tone="error">{error}</Notice>}<Button disabled={busy} onClick={() => void perform(async () => { await api(connection, '/plugins/skills/remove', { name: removing }); setRemoving(''); await load(); })}>Remove skill</Button></DialogContent></Dialog>
  </section>;
}
