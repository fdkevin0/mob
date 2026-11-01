import { Actions, Feedback, Result, usePlugin } from './shared';
import { ClearSecrets, SchemaFields, schemas } from './SchemaFields';
import type { Connection } from '../api';
import type { TelegramConfig } from './types';
export function TelegramPlugin({connection,initial,active,status}:{connection:Connection;initial:TelegramConfig;active:boolean;status:string}) {
 const {config,setConfig,busy,error,notice,result,save,test,unavailable,clearSecret,secrets}=usePlugin('telegram',initial,connection);
if (!active) return null;
 return <><Feedback error={error} notice={notice}/><form onSubmit={save}><fieldset disabled={busy}><p>Connect your bot to this local assistant. Only private messages from the allowed user are processed. Keep this computer running to receive replies.</p>
          <SchemaFields schema={schemas.telegram} value={config} onChange={v=>setConfig(v as TelegramConfig)}/>
          <p role="status">{status || 'Disabled'}</p><p className="muted">An active webhook or another polling client must be stopped before this connection can receive messages. /new starts a new conversation.</p>
        <ClearSecrets schema={schemas.telegram} enabled={config.enabled} secrets={secrets} clear={clearSecret}/><Actions busy={busy} unavailable={unavailable} test={test}/></fieldset></form><Result value={result}/></>;
}
