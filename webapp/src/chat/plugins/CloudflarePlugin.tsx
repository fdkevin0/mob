import { useState } from 'react';
import { api, type Connection } from '../api';
import { Field, Toggle, Feedback, Result, Actions, usePlugin, requestId } from './shared';
import type { CloudflareConfig } from './types';
export function CloudflarePlugin({connection,initial,active}:{connection:Connection;initial:CloudflareConfig;active:boolean}) {
 const {config,setConfig,busy,error,notice,setNotice,result,setResult,perform,save,test,unavailable,clearSecret,secrets}=usePlugin('cloudflare',initial,connection);
const [operation,setOperation]=useState('ai.models');const [argument,setArgument]=useState('');const [params,setParams]=useState('[]');const [cursor,setCursor]=useState('');
if (!active) return null;
 return <><Feedback error={error} notice={notice}/><form onSubmit={save}><fieldset disabled={busy}><Toggle value={config.enabled} onChange={enabled=>setConfig({...config,enabled})}>Enable cloudflare</Toggle><p>Use a scoped API token and the account containing your resources.</p>
          <Field label="Cloudflare account ID" value={config.accountId} onChange={v => setConfig( { ...config, accountId: v })} />
          <Field label="Cloudflare API Token" secret value={config.token} hint={config.hasToken ? 'Saved. Leave blank to keep it for this account.' : undefined} onChange={v => setConfig( { ...config, token: v })} />
          {(['model', 'embeddingModel', 'index', 'databaseId', 'namespaceId', 'bucket', 'accessKey'] as const).map((field, i) => <Field key={field} label={['Workers AI model (ai.run)', 'Workers AI embedding model', 'Vectorize index', 'D1 database ID', 'KV namespace ID', 'R2 bucket', 'R2 S3 Access Key ID'][i]} value={config[field]} onChange={v => setConfig( { ...config, [field]: v })} />)}
          <Field label="R2 S3 Secret Access Key" secret value={config.secretKey} hint={config.hasSecretKey ? 'Saved. Leave blank to keep it for this account and access key.' : 'Required for object access. API Token alone is used for bucket management.'} onChange={v => setConfig( { ...config, secretKey: v })} />
        <div><button type="button" className="plain" disabled={config.enabled || !!secrets['token']} onClick={()=>clearSecret('token')}>{secrets['token'] ? "Will clear token on save" : "Clear saved token"}</button><button type="button" className="plain" disabled={config.enabled || !!secrets['secretKey']} onClick={()=>clearSecret('secretKey')}>{secrets['secretKey'] ? "Will clear secretKey on save" : "Clear saved secretKey"}</button><small>Disable the plugin before clearing saved credentials, then save.</small></div><Actions busy={busy} unavailable={unavailable} test={test}/></fieldset></form><section><h2>Cloud services</h2><p>Actions use saved configuration. D1 executes the SQL you enter, including writes. Workers AI calls may incur provider charges.</p>
        <label className="plugin-field">Operation<select value={operation} onChange={e => { setOperation(e.target.value); setCursor(''); setResult(undefined); }}>{['ai.models', 'ai.run', 'vectorize.indexes', 'vectorize.query', 'd1.databases', 'd1.query', 'kv.namespaces', 'kv.get', 'r2.buckets', 'r2.list', 'r2.get'].map(op => <option key={op}>{op}</option>)}</select></label>
        <label className="plugin-field">Prompt / search text / key / SQL<textarea rows={4} value={argument} onChange={e => setArgument(e.target.value)} /></label>
        {operation === 'd1.query' && <Field label="SQL parameters (JSON array)" value={params} onChange={setParams} />}
        {operation === 'r2.list' && <Field label="Next-page cursor (optional)" value={cursor} onChange={setCursor} />}
        <button disabled={unavailable} onClick={() => void perform(async () => { const values: unknown = operation === 'd1.query' ? JSON.parse(params) : []; if (!Array.isArray(values)) throw new Error('SQL parameters must be a JSON array.'); setResult(await api(connection, '/plugins/cloudflare/action', { operation, text: argument, key: argument, sql: argument, params: values, cursor })); })}>Run {operation}</button>
      </section><Result value={result}/></>;
}
