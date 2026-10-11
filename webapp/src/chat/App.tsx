import { isToolUIPart } from 'ai';
import { useConversation } from './useConversation';
import { useCompletion } from './useCompletion';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Conversation as ChatConversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '../components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../components/ai-elements/message';
import { api, defaultURL, unauthorizedEvent, type Connection, type Conversation, type Snapshot } from './api';
import type { Action } from './contracts';

import { Plugins } from './Plugins';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function App() {
  const [connection, setConnection] = useState<Connection>();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const desktop = window.go?.main?.Desktop;
    if (desktop) {
      desktop.Connection().then(setConnection).catch(e => setError(errorText(e))).finally(() => setLoading(false));
      return;
    }
    const code = pairingCode();
    const saved = savedToken();
    const restore = code ? claimPairing(code) : saved ? verify({ url: defaultURL(), token: saved }) : Promise.resolve(undefined);
    restore.then(next => { if (next) { saveToken(next.token); setConnection(next); } })
      .catch(e => setError(current => current || errorText(e))).finally(() => setLoading(false));
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
      clearToken(rejected); setConnection(undefined); setError('The access token was replaced. Run mob open to sign in again.');
    };
    window.addEventListener(unauthorizedEvent, signOut);
    return () => window.removeEventListener(unauthorizedEvent, signOut);
  }, []);
  async function connect(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    const next = { url: defaultURL(), token: token.trim() };
    try { await api(next, '/config'); saveToken(next.token); setConnection(next); }
    catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }
  if (connection) return <Workspace connection={connection} disconnect={() => { clearToken(); setConnection(undefined); }} />;
  // The desktop connects by itself, so a failure there has no token form to retry.
  if (error && window.go?.main?.Desktop) return <main className="connect"><p className="eyebrow">MOB / LOCAL WORKSPACE</p><h1>Mob could not start.</h1><p role="alert" className="startup-error">{error}</p></main>;
  return <main className="connect"><p className="eyebrow">MOB / LOCAL WORKSPACE</p><h1>A place to think.</h1><p>Connect to your local Go service. Your conversations stay in SQLite on this computer.</p>
    <form onSubmit={connect}><label htmlFor="token">Local access token</label><input id="token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required />
      <p className="muted">Run <code>mob open</code> to sign in with a one-time link, or paste the token file shown by <code>mob serve</code>. The desktop app connects automatically.</p><button disabled={loading}>{loading ? 'Connecting…' : 'Open workspace'}</button></form>
    {error && <p role="alert">{error}</p>}</main>;
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

// pairingCode takes a one-time code from the link mob open prints, removing it from the address bar.
function pairingCode() {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('pair');
  if (code) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return code;
}
// verify checks a saved token before opening the workspace; a 401 signs out through unauthorizedEvent.
async function verify(connection: Connection) {
  await api(connection, '/config');
  return connection;
}
async function claimPairing(code: string): Promise<Connection> {
  const url = defaultURL();
  const response = await fetch(`${url}/api/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  const { token } = await response.json() as { token: string };
  return { url, token };
}

function Workspace({ connection, disconnect }: { connection: Connection; disconnect: () => void }) {
  const [plugins, setPlugins] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<{ id: string; snapshot: Snapshot }>();
  const [model, setModel] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [background,setBackground]=useState(false);
  async function refreshList() { setConversations(await api(connection, '/conversations')); }
  async function open(id: string) {
    setSwitching(true); setError('');
    try { const snapshot = await api<Snapshot>(connection, `/conversations/${id}`); setSelected({ id, snapshot }); }
    catch (e) { setError(errorText(e)); } finally { setSwitching(false); }
  }
  function act(action: Action) {
    if (action.kind === 'open-conversation' && action.conversationId) void refreshList().then(() => open(action.conversationId!)).catch(e => setError(errorText(e)));
    else if (action.kind === 'open-plugins' || action.kind === 'compose-mail') setPlugins(true);
  }
  async function create() {
    setSwitching(true);
    try { const next = await api<Conversation>(connection, '/conversations', {}); await refreshList(); await open(next.id); }
    catch (e) { setError(errorText(e)); } finally { setSwitching(false); }
  }
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [list, runtime] = await Promise.all([api<Conversation[]>(connection, '/conversations'), api<{background:boolean}>(connection, '/runtime')]);
        if (!live) return; setConversations(list); setBackground(runtime.background);
        if (list.length) await open(list[0].id); else await create();
      } catch (e) { if (live) setError(errorText(e)); }
    })();
    return () => { live = false; };
  }, [connection]);
  if (plugins) return <Plugins connection={connection} close={() => setPlugins(false)} />;
  return <div className="workspace">
    <aside className="sidebar"><div className="brand">mob<span>LOCAL</span></div><button className="new-chat" disabled={busy || switching} onClick={() => void create()}>＋ New conversation</button>
      <nav aria-label="Conversations">{conversations.map(c => <button className="conversation-link" key={c.id} aria-current={selected?.id === c.id ? 'page' : undefined} disabled={busy || switching} onClick={() => void open(c.id)}>{c.title}</button>)}</nav>
      <button className="plain" disabled={busy} onClick={() => setPlugins(true)}>Plugins & cloud services</button>
      <div className="sidebar-footer"><span className="status-dot" /> History · on this computer<button className="plain" onClick={disconnect} disabled={busy}>Disconnect</button></div>
    </aside>
    <main className="chat-main"><header><div><p className="eyebrow">YOUR WORKSPACE</p><strong title="This conversation's model; /model NAME switches it">{model?.startsWith('demo/') ? 'Demo mode · no model calls' : model ?? 'Connecting…'}</strong></div><span className="badge" title={background ? "Continues after this window closes" : "Lifetime is controlled by the process that started the service"}>{background ? "Background service" : "Session service"}</span></header>
      {error && <div className="error" role="alert">{error}<button className="plain" onClick={() => void refreshList().catch(e => setError(errorText(e)))}>Refresh</button></div>}
      {selected ? <Thread key={selected.id} connection={connection} id={selected.id} initial={selected.snapshot} onModel={setModel} onBusy={setBusy} onChanged={() => { void refreshList().catch(e => setError(errorText(e))); }} onAction={act} /> : <div className="loading" role="status">Opening workspace…</div>}
    </main>
  </div>;
}

function Thread({ connection, id, initial, onModel, onBusy, onChanged, onAction }: { connection: Connection; id: string; initial: Snapshot; onModel: (model: string) => void; onBusy: (busy: boolean) => void; onChanged: () => void; onAction: (action: Action) => void }) {
  const { model, input, setInput, remoteBusy, approvalBusy, failure, messages, streaming, busy, error, submit, decide, cancel, commandResult, dismissCommand } = useConversation({ connection, id, initial, onBusy, onChanged, onAction });
  const completion = useCompletion({ connection, id, input, setInput });
  useEffect(() => { onModel(model); }, [model, onModel]);
  return <>
    <ChatConversation className="conversation"><ConversationContent className="conversation-content">
      {messages.length === 0 && <ConversationEmptyState title="What’s on your mind?" description="Ask a question, explore an idea, or save something to remember." />}
      {messages.map(message => <Message key={message.id} from={message.role}>
        <p className="message-role">{message.role === 'user' ? 'YOU' : 'MOB'}</p><MessageContent>
          {message.parts.map((part, index) => {
            if (part.type === 'text') return <MessageResponse key={index} isAnimating={streaming && message === messages.at(-1)}>{part.text}</MessageResponse>;
            if (part.type === 'reasoning') return <details className="reasoning" key={index}><summary>Reasoning</summary><p>{part.text}</p></details>;
            if (isToolUIPart(part)) return <section className="tool-card" key={part.toolCallId}><strong>{part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)}</strong><span className="tool-state">{part.state}</span>
              <pre>{JSON.stringify(part.input, null, 2)}</pre>
              {part.state === 'approval-requested' && <div><p>{part.type === 'tool-remember' ? 'Save this fact locally?' : 'Allow this request?'} Approval expires after one hour.</p><button disabled={busy} onClick={() => void decide(part.approval.id, true)}>Approve</button><button className="secondary" disabled={busy} onClick={() => void decide(part.approval.id, false)}>Deny</button></div>}
              {part.state === 'output-available' && <pre>{JSON.stringify(part.output, null, 2)}</pre>}
              {part.state === 'output-error' && <p role="alert">{part.errorText}</p>}
            </section>;
            return null;
          })}
          {message.metadata?.error && <p className="error" role="status">{message.metadata.status}: {message.metadata.error}</p>}
        </MessageContent></Message>)}
      {busy && <p className="muted" role="status">{remoteBusy && !streaming && !approvalBusy ? 'A turn is running in another client…' : 'Working…'}</p>}
    </ConversationContent><ConversationScrollButton /></ChatConversation>
    <div className="composer-area">{(failure || error) && <p className="error" role="alert">{failure || error?.message}</p>}
      {commandResult && <section className="command-result" aria-label="Command result"><MessageResponse>{commandResult}</MessageResponse><button className="plain" onClick={dismissCommand}>Dismiss</button></section>}
      {completion.suggestions.length > 0 && <ul className="suggestions" id="command-suggestions" role="listbox" aria-label="Command suggestions">
        {completion.suggestions.map((s, i) => <li key={`${i}-${s.value}`} id={`suggestion-${i}`} role="option" aria-selected={i === completion.selected} onMouseDown={e => { e.preventDefault(); completion.accept(i); }}>
          <span>{s.label}</span>{s.detail && <small>{s.detail}</small>}</li>)}
      </ul>}
      <form className="composer" onSubmit={submit}><label className="sr-only" htmlFor="message">Message</label><textarea id="message" placeholder="Message Mob…" value={input} onChange={e => setInput(e.target.value)} maxLength={16000} rows={2}
        aria-autocomplete="list" aria-controls={completion.suggestions.length ? 'command-suggestions' : undefined} aria-activedescendant={completion.suggestions.length ? `suggestion-${completion.selected}` : undefined}
        onKeyDown={e => { if (completion.onKeyDown(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
        {busy ? <button type="button" onClick={() => void cancel()}>Stop</button> : <button disabled={!input.trim()}>Send ↑</button>}
      </form><p className="composer-hint">Type / for commands · Tab completes · Enter to send · Shift+Enter for a new line</p>
    </div>
  </>;
}
