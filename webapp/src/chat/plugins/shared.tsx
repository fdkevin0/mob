import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { useState, type ReactNode, type FormEvent } from 'react';
import { api, type Connection } from '../api';
import type { Configs } from './types';
import { Notice } from '../../components/ui/notice';
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export const requestId = () => crypto.randomUUID().replaceAll('-', '');
export function Field({ label, value, onChange, secret = false, type = 'text', hint }: { label: string; value: string | number | undefined; onChange: (value: string) => void; secret?: boolean; type?: string; hint?: string }) {
  return <Label className="plugin-field">{label}<Input type={secret ? 'password' : type} autoComplete="off" value={value ?? ''} onChange={e => onChange(e.target.value)} />{hint && <small>{hint}</small>}</Label>;
}
export function Toggle({ children, value, onChange }: { children: ReactNode; value: boolean; onChange: (v: boolean) => void }) {
  return <Label className="plugin-toggle"><input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />{children}</Label>;
}


export function usePlugin<K extends keyof Configs>(name: K, initial: Configs[K], connection: Connection) {
 const [config,setConfig]=useState(initial);
 const [saved,setSaved]=useState(initial);
 const [error,setError]=useState(''); const [notice,setNotice]=useState(''); const [busy,setBusy]=useState(false); const [result,setResult]=useState<unknown>();
 const [secrets,setSecrets]=useState<Record<string,{mode:'clear'}>>({});
 async function perform(action:()=>Promise<void>) { setBusy(true);setError('');setNotice('');try{await action()}catch(e){setError(errorText(e))}finally{setBusy(false)} }
 async function save(event:FormEvent) {event.preventDefault();await perform(async()=>{ const next=await api<Configs>(connection,`/plugins/${name}`,{...config,secrets});setConfig(next[name]);setSaved(next[name]);setSecrets({});setNotice('Configuration saved.'); });}
 async function test() { await perform(async()=>{setResult(await api(connection,`/plugins/${name}/test`,{}));setNotice('Connection test passed.');}); }
 const dirty=JSON.stringify(config)!==JSON.stringify(saved) || Object.keys(secrets).length>0;
 return {config,setConfig,busy,error,notice,setNotice,result,setResult,perform,save,test,unavailable:busy||dirty||!saved.enabled,clearSecret:(key:string)=>setSecrets(v=>({...v,[key]:{mode:'clear'}})),secrets};
}
export function Feedback({error,notice}:{error:string;notice:string}) { return <>{error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}</>; }
export function Result({value}:{value:unknown}) {return value===undefined?null:<pre className="plugin-result" aria-label="Operation result">{JSON.stringify(value,null,2)}</pre>;}
export function Actions({busy,unavailable,test}:{busy:boolean;unavailable:boolean;test:()=>Promise<void>}) {return <><p className="muted">Credentials are stored locally in the database. Passwords and tokens are never returned to this form.</p><div className="plugin-actions"><Button disabled={busy}>Save configuration</Button><Button type="button" variant="outline" disabled={unavailable} onClick={()=>void test()}>Test saved configuration</Button></div></>;}
