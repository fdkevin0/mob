import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, defaultURL, isLocalMob, isPublicWeb, readOffer, unauthorizedEvent, type Connection } from './api';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { Workspace } from './Workspace';
import { Runners } from './Runners';
import { Lobby } from './Lobby';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function App() {
  const [connection, setConnection] = useState<Connection>();
  const [token, setToken] = useState('');
  const [address, setAddress] = useState(serviceURL);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // The public web opens the workspace without a runner; prompting shows how to connect one, and draft keeps what was typed meanwhile.
  const [prompting, setPrompting] = useState(false);
  // The dialog first offers a choice of runner: the user's own one, or one deployed to their cloud account.
  const [choice, setChoice] = useState<'own' | 'cloud'>();
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const desktop = window.go?.main?.Desktop;
    if (desktop) {
      desktop.Connection().then(setConnection).catch(e => setError(errorText(e))).finally(() => setLoading(false));
      return;
    }
    const saved = savedToken();
    let url = serviceURL();
    // A sign-in link shows its progress and any failure in the connect dialog.
    if (/[#&](offer|pair)=/.test(window.location.hash)) { setPrompting(true); setChoice('own'); }
    const restore = async () => {
      const link = signInLink();
      if (link) { url = link.url; return claimPairing(link); }
      return saved ? verify({ url, token: saved }) : undefined;
    };
    restore().then(next => { if (next) { saveConnection(next); setConnection(next); setPrompting(false); } })
      .catch(e => setError(current => current || reachText(url, e))).finally(() => setLoading(false));
  }, []);
  // A replaced token signs this window out; the desktop reads the new token instead.
  const active = useRef<Connection | undefined>(undefined); active.current = connection;
  useEffect(() => {
    const signOut = (event: Event) => {
      const rejected = (event as CustomEvent<string>).detail;
      const current = active.current?.token ?? savedToken();
      if (current !== null && current !== rejected) return;
      const desktop = window.go?.main?.Desktop;
      if (desktop) { desktop.Connection().then(next => setConnection(current => current?.token === next.token ? current : next)).catch(e => setError(errorText(e))); return; }
      clearToken(rejected); setConnection(undefined); setPrompting(true); setChoice('own'); setError(active.current?.runner ? 'The runner’s local access token changed. Restart mob runner on that computer.' : `The access token was replaced. Run ${openCommand()} to sign in again.`);
    };
    window.addEventListener(unauthorizedEvent, signOut);
    return () => window.removeEventListener(unauthorizedEvent, signOut);
  }, []);
  async function connect(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    const next = { url: isPublicWeb() ? address.trim().replace(/\/+$/, '') : defaultURL(), token: token.trim() };
    if (!isLocalMob(next.url) && isPublicWeb()) { setError('Enter the address of Mob on this computer, such as http://127.0.0.1:8787.'); setLoading(false); return; }
    try { await api(next, '/config'); saveConnection(next); setConnection(next); setPrompting(false); }
    catch (e) { setError(reachText(next.url, e)); } finally { setLoading(false); }
  }
  const open = (next: Connection) => { setConnection(next); setPrompting(false); };
  if (connection) return <Workspace connection={connection} draft={draft} clearDraft={() => setDraft('')} disconnect={() => { if (!connection.runner) clearToken(); setConnection(undefined); }} />;
  // The desktop connects by itself, so a failure there has no token form to retry.
  if (error && window.go?.main?.Desktop) return <main className="connect"><Logo /><h1>Mob could not start.</h1><p role="alert" className="startup-error">{error}</p></main>;
  const panel = <>
    {isPublicWeb() && <Runners connect={open} />}
    <form onSubmit={connect}>{isPublicWeb() && <><Label htmlFor="address">Mob address</Label><Input id="address" type="url" value={address} onChange={e => setAddress(e.target.value)} required /></>}<Label htmlFor="token">Local access token</Label><Input id="token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required />
      <p className="muted">Run <code>{openCommand()}</code> to sign in with a one-time link, or paste the token file shown by <code>mob serve</code>. The desktop app connects automatically.</p><Button disabled={loading}>{loading ? 'Connecting…' : 'Open workspace'}</Button></form>
    {error && <p role="alert">{error}</p>}</>;
  if (isPublicWeb()) return <>
    <Lobby draft={draft} setDraft={setDraft} connecting={loading && !prompting} notice={error} connect={() => { setChoice(undefined); setPrompting(true); }} />
    <Dialog open={prompting} onOpenChange={setPrompting}><DialogContent className="connect-dialog">
      <DialogTitle className="dialog-title">Connect a runner</DialogTitle>
      <DialogDescription className="dialog-description">Mob needs a runner to send messages. Choose where it runs.</DialogDescription>
      {choice ? <><Button type="button" variant="ghost" className="choice-back" onClick={() => { setChoice(undefined); setError(''); }}>← Other runners</Button>{choice === 'cloud' ? <Runners connect={open} deploy /> : panel}</> : <div className="runner-choices">
        <Button type="button" variant="outline" className="runner-choice" onClick={() => setChoice('own')}><strong>Your own runner</strong><span>Mob on this computer, or on another computer you pair. Conversations stay there.</span></Button>
        <Button type="button" variant="outline" className="runner-choice" onClick={() => setChoice('cloud')}><strong>Deploy to the cloud</strong><span>Mob in your own account at Render or another host, on its free tier. No computer needs to stay on.</span></Button>
        <Button type="button" variant="outline" className="runner-choice" disabled><strong>Cloud runner <small>Coming soon</small></strong><span>A runner hosted for you, with nothing to install.</span></Button>
      </div>}</DialogContent></Dialog></>;
  return <main className="connect"><Logo /><h1>A place to think.</h1><p>Connect to your local Go service. Your conversations stay in SQLite on this computer.</p>{panel}</main>;
}

// Storage can be unavailable, such as in a private window; the token form still works then.
const tokenKey = 'mob-token';
function savedToken() {
  try { return localStorage.getItem(tokenKey) ?? sessionStorage.getItem(tokenKey); } catch { return null; }
}
function saveToken(token: string) {
  try { localStorage.setItem(tokenKey, token); sessionStorage.removeItem(tokenKey); } catch { /* sign in again next time */ }
}
// clearToken forgets the saved token; given one, it keeps a different token another tab saved since.
function clearToken(only?: string) {
  try {
    for (const storage of [localStorage, sessionStorage]) if (only === undefined || storage.getItem(tokenKey) === only) storage.removeItem(tokenKey);
  } catch { /* nothing stored */ }
}

// serviceURL is where the API is: the page's own origin, or for the public web
// the Mob address the last sign-in link gave.
function serviceURL() {
  if (!isPublicWeb()) return defaultURL();
  let saved: string | null = null;
  try { saved = localStorage.getItem(urlKey); } catch { /* use the default address */ }
  return saved && isLocalMob(saved) ? saved : 'http://127.0.0.1:8787';
}
const urlKey = 'mob-url';
function saveConnection(connection: Connection) {
  saveToken(connection.token);
  if (isPublicWeb()) try { localStorage.setItem(urlKey, connection.url); } catch { /* the address field keeps its default */ }
}
const openCommand = () => isPublicWeb() ? 'mob open --web' : 'mob open';
// reachText explains a failed request; the public web adds why a browser may refuse to reach Mob.
function reachText(url: string, error: unknown) {
  if (!isPublicWeb() || !(error instanceof TypeError)) return errorText(error);
  return `This page could not reach Mob at ${url}. Check that Mob is running, and allow access to apps on this device if the browser asks. Safari does not let this page reach Mob; use mob open there instead.`;
}

// signInLink takes the one-time code from the link mob open prints, removing it
// from the address bar. The public web's link also says where Mob listens.
function signInLink() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const offer = isPublicWeb() ? fragment.get('offer') : null;
  const code = isPublicWeb() ? null : fragment.get('pair');
  if (offer || code) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (offer) return readOffer(offer);
  return code ? { url: defaultURL(), code } : undefined;
}
// verify checks a saved token before opening the workspace; a 401 signs out through unauthorizedEvent.
async function verify(connection: Connection) {
  await api(connection, '/config');
  return connection;
}
async function claimPairing({ url, code }: { url: string; code: string }): Promise<Connection> {
  const response = await fetch(`${url}/api/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  const { token } = await response.json() as { token: string };
  return { url, token };
}
