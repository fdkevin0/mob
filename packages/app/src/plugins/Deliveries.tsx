import { Button } from '@mob/ui/button';
import { useEffect, useState } from 'react';
import { api, ok, rpcOf, type Connection } from '../api';
import { errorText } from './shared';
import type { Delivery } from '../contracts';
import { Notice } from '@mob/ui/notice';
export function Deliveries({connection}:{connection:Connection}) {
 const [rows,setRows]=useState<Delivery[]>([]);const [error,setError]=useState('');
 async function load(){try{setRows(await ok(rpcOf(connection).deliveries.$get()));setError('');}catch(e){setError(errorText(e));}}
 useEffect(()=>{void load();},[connection]);
 return <section><h2>Recent deliveries</h2><Button onClick={()=>void load()}>Refresh deliveries</Button><p>Uncertain or interrupted sends are never automatically retried. Check the recipient before composing another message.</p>{error && <Notice tone="error">{error}</Notice>}{rows.length===0 && <p>No deliveries yet.</p>}{rows.map(d=><article key={d.id}><h3>{d.id}</h3><p>{d.state} · {d.updatedAt?new Date(d.updatedAt).toLocaleString():'Time unknown'}</p>{d.error && <p>{d.error}</p>}{d.reply && <details><summary>Saved reply</summary><pre className="mail-body">{d.reply}</pre></details>}</article>)}</section>;
}
