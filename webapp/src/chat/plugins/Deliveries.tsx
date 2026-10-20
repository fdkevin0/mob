import { Button } from '../../components/ui/button';
import { useEffect, useState } from 'react';
import { api, type Connection } from '../api';
import { errorText } from './shared';
import type { Delivery } from '../contracts';
export function Deliveries({connection}:{connection:Connection}) {
 const [rows,setRows]=useState<Delivery[]>([]);const [error,setError]=useState('');
 async function load(){try{setRows(await api(connection,'/deliveries'));setError('');}catch(e){setError(errorText(e));}}
 useEffect(()=>{void load();},[connection]);
 return <section><h2>Recent deliveries</h2><Button onClick={()=>void load()}>Refresh deliveries</Button><p>Uncertain or interrupted sends are never automatically retried. Check the recipient before composing another message.</p>{error && <p role="alert">{error}</p>}{rows.length===0 && <p>No deliveries yet.</p>}{rows.map(d=><article key={d.id}><h3>{d.id}</h3><p>{d.state} · {d.updatedAt?new Date(d.updatedAt).toLocaleString():'Time unknown'}</p>{d.error && <p>{d.error}</p>}{d.reply && <details><summary>Saved reply</summary><pre className="mail-body">{d.reply}</pre></details>}</article>)}</section>;
}
