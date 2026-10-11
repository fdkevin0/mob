import { useState } from 'react';
import { api, type Connection } from '../api';
import { Field, Toggle, Feedback, Result, Actions, usePlugin, requestId } from './shared';
import type { EmailConfig, Endpoint, Summary, Mail, Draft } from './types';
const emptyDraft:Draft={to:'',subject:'',text:''};
export function EmailPlugin({connection,initial,active}:{connection:Connection;initial:EmailConfig;active:boolean}) {
 const {config,setConfig,busy,error,notice,setNotice,result,setResult,perform,save,test,unavailable,clearSecret,secrets}=usePlugin('email',initial,connection);
const [inbox,setInbox]=useState<Summary[]>(); const [mail,setMail]=useState<Mail>();const [draft,setDraft]=useState<Draft>(emptyDraft);const [review,setReview]=useState(false);const [sendID,setSendID]=useState(requestId);
 function endpoint(kind:'imap'|'smtp',key:keyof Endpoint,value:string|number) {setConfig(c=>({...c,[kind]:{...c[kind],[key]:value}}));}
 function editDraft(key:keyof Draft,value:string){setDraft(d=>({...d,[key]:value}));setReview(false);setSendID(requestId());}
if (!active) return null;
 return <><Feedback error={error} notice={notice}/><form onSubmit={save}><fieldset disabled={busy}><Toggle value={config.enabled} onChange={enabled=>setConfig({...config,enabled})}>Enable email</Toggle><p>Read INBOX over IMAP and send mail over SMTP. Use an app password if your provider requires one.</p>
          <Field label="From address" value={config.from} onChange={v => setConfig( { ...config, from: v })} />
          <div className="plugin-columns">{(['imap', 'smtp'] as const).map(kind => <section key={kind}><h2>{kind.toUpperCase()}</h2>
            <Field label={`${kind.toUpperCase()} host`} value={config[kind].host} onChange={v => endpoint(kind, 'host', v)} />
            <Field label={`${kind.toUpperCase()} port`} type="number" value={config[kind].port || ''} hint={kind === 'imap' ? 'Usually 993 (TLS) or 143 (STARTTLS)' : 'Usually 465 (TLS) or 587 (STARTTLS)'} onChange={v => endpoint(kind, 'port', Number(v))} />
            <label className="plugin-field">{kind.toUpperCase()} security<select value={config[kind].security || ''} onChange={e => endpoint(kind, 'security', e.target.value)}><option value="">Choose…</option><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label>
            <Field label={`${kind.toUpperCase()} username`} value={config[kind].username} onChange={v => endpoint(kind, 'username', v)} />
            <Field label={`${kind.toUpperCase()} password`} secret value={config[kind].password} hint={config[kind].hasPassword ? 'Saved. Leave blank to keep it for the same host and username.' : undefined} onChange={v => endpoint(kind, 'password', v)} />
          </section>)}</div><div><button type="button" className="plain" disabled={config.enabled || !!secrets['imap.password']} onClick={()=>clearSecret('imap.password')}>{secrets['imap.password'] ? "Will clear imap.password on save" : "Clear saved imap.password"}</button><button type="button" className="plain" disabled={config.enabled || !!secrets['smtp.password']} onClick={()=>clearSecret('smtp.password')}>{secrets['smtp.password'] ? "Will clear smtp.password on save" : "Clear saved smtp.password"}</button><small>Disable the plugin before clearing saved credentials, then save.</small></div><Actions busy={busy} unavailable={unavailable} test={test}/></fieldset></form><section><h2>Mailbox</h2><button disabled={unavailable} onClick={() => void perform(async () => { setInbox(await api(connection, '/plugins/email/inbox')); setMail(undefined); })}>Refresh INBOX</button><p className="muted">Latest 50 messages. Reading previews leaves messages unread. Attachments are listed only.</p>
        {inbox?.length === 0 && <p>INBOX is empty.</p>}{inbox?.map(m => <button className="mail-row" key={`${m.validity}:${m.uid}`} disabled={unavailable} onClick={() => void perform(async () => setMail(await api(connection, `/plugins/email/messages/${m.uid}?validity=${m.validity}`)))}><strong>{m.subject || '(no subject)'}</strong><span>{m.from} · {m.date}</span></button>)}
        {mail && <article><h3>{mail.subject}</h3><p>{mail.from}</p><pre className="mail-body">{mail.text}</pre><button disabled={unavailable} onClick={() => void perform(async () => { setResult(await api(connection, '/plugins/email/analyze', { uid: mail.uid, validity: mail.validity })); })}>Analyze with AI</button><p className="muted">Analysis sends the email text to your configured model.</p>{mail.attachments.length > 0 && <p>Attachments: {mail.attachments.join(', ')}</p>}<button disabled={unavailable} onClick={() => { setDraft({ to: mail.from, subject: `Re: ${mail.subject}`, text: '' }); setSendID(requestId()); setReview(false); }}>Compose reply</button></article>}
        <h2>Compose email</h2><form onSubmit={e => { e.preventDefault(); setReview(true); }}><fieldset disabled={unavailable || review}>
          <Field label="To" value={draft.to} onChange={v => editDraft('to', v)} /><Field label="Subject" value={draft.subject} onChange={v => editDraft('subject', v)} />
          <label className="plugin-field">Message body<textarea rows={7} value={draft.text} onChange={e => editDraft('text', e.target.value)} /></label><button disabled={!draft.to.trim() || !draft.text.trim()}>Review email</button>
        </fieldset></form>
        {review && <section className="mail-review" aria-label="Review email"><h3>Send this email?</h3><p>To: {draft.to}</p><p>Subject: {draft.subject}</p><pre className="mail-body">{draft.text}</pre>
          <button disabled={unavailable} onClick={() => void perform(async () => { await api(connection, '/plugins/email/send', { ...draft, requestId: sendID }); setNotice('Email accepted by SMTP.'); setDraft(emptyDraft); setReview(false); setSendID(requestId()); })}>Send email</button>
          <button className="secondary" disabled={busy} onClick={() => setReview(false)}>Edit</button>
        </section>}
      </section><Result value={result}/></>;
}
