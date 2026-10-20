import { Button } from '../../components/ui/button';

import { api, type Connection } from '../api';
import { Field, Toggle, Feedback, Result, Actions, usePlugin, requestId } from './shared';
import type { TelegramConfig } from './types';
export function TelegramPlugin({connection,initial,active,status}:{connection:Connection;initial:TelegramConfig;active:boolean;status:string}) {
 const {config,setConfig,busy,error,notice,setNotice,result,setResult,perform,save,test,unavailable,clearSecret,secrets}=usePlugin('telegram',initial,connection);
if (!active) return null;
 return <><Feedback error={error} notice={notice}/><form onSubmit={save}><fieldset disabled={busy}><Toggle value={config.enabled} onChange={enabled=>setConfig({...config,enabled})}>Enable telegram</Toggle><p>Connect your bot to this local assistant. Only private messages from the allowed user are processed. Keep this computer running to receive replies.</p>
          <Field label="Bot Token" secret value={config.token} hint={config.hasToken ? 'Saved. Leave blank to keep it.' : 'Create a bot with @BotFather.'} onChange={v => setConfig( { ...config, token: v })} />
          <Field label="Allowed Telegram user ID" type="number" value={config.userId || ''} onChange={v => setConfig( { ...config, userId: Number(v) })} />
          <p role="status">{status || 'Disabled'}</p><p className="muted">An active webhook or another polling client must be stopped before this connection can receive messages. /new starts a new conversation.</p>
        <div><Button type="button" variant="ghost" disabled={config.enabled || !!secrets['token']} onClick={()=>clearSecret('token')}>{secrets['token'] ? "Will clear token on save" : "Clear saved token"}</Button><small>Disable the plugin before clearing saved credentials, then save.</small></div><Actions busy={busy} unavailable={unavailable} test={test}/></fieldset></form><Result value={result}/></>;
}
