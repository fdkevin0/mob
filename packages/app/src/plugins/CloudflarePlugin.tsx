import { Button } from '@mob/ui/button';
import { Textarea } from '@mob/ui/textarea';
import { Label } from '@mob/ui/label';
import { useState } from 'react';
import { api, type Connection } from '../api';
import { Field, Feedback, Result, Actions, usePlugin } from './shared';
import { ClearSecrets, SchemaFields, schemas } from './SchemaFields';
import type { CloudflareConfig } from './types';
export function CloudflarePlugin({connection,initial,active}:{connection:Connection;initial:CloudflareConfig;active:boolean}) {
 const {config,setConfig,busy,error,notice,setResult,result,perform,save,test,unavailable,clearSecret,secrets}=usePlugin('cloudflare',initial,connection);
const [operation,setOperation]=useState('ai.models');const [argument,setArgument]=useState('');const [params,setParams]=useState('[]');const [cursor,setCursor]=useState('');
if (!active) return null;
 return <><Feedback error={error} notice={notice}/><form onSubmit={save}><fieldset disabled={busy}><SchemaFields schema={schemas.cloudflare} value={config} onChange={v=>setConfig(v as CloudflareConfig)}/>
        <ClearSecrets schema={schemas.cloudflare} enabled={config.enabled} secrets={secrets} clear={clearSecret}/><Actions busy={busy} unavailable={unavailable} test={test}/></fieldset></form><section><h2>Cloud services</h2><p>Actions use saved configuration. D1 executes the SQL you enter, including writes. Workers AI calls may incur provider charges.</p>
        <Label className="plugin-field">Operation<select value={operation} onChange={e => { setOperation(e.target.value); setCursor(''); setResult(undefined); }}>{['ai.models', 'ai.run', 'vectorize.indexes', 'vectorize.query', 'd1.databases', 'd1.query', 'kv.namespaces', 'kv.get', 'r2.buckets', 'r2.list', 'r2.get'].map(op => <option key={op}>{op}</option>)}</select></Label>
        <Label className="plugin-field">Prompt / search text / key / SQL<Textarea rows={4} value={argument} onChange={e => setArgument(e.target.value)} /></Label>
        {operation === 'd1.query' && <Field label="SQL parameters (JSON array)" value={params} onChange={setParams} />}
        {operation === 'r2.list' && <Field label="Next-page cursor (optional)" value={cursor} onChange={setCursor} />}
        <Button disabled={unavailable} onClick={() => void perform(async () => { const values: unknown = operation === 'd1.query' ? JSON.parse(params) : []; if (!Array.isArray(values)) throw new Error('SQL parameters must be a JSON array.'); setResult(await api(connection, '/plugins/cloudflare/action', { operation, text: argument, key: argument, sql: argument, params: values, cursor })); })}>Run {operation}</Button>
      </section><Result value={result}/></>;
}
