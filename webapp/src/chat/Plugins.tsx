import { useEffect, useState } from 'react';
import { api, type Connection } from './api';
import type { Configs } from './plugins/types';
import { EmailPlugin } from './plugins/EmailPlugin';
import { TelegramPlugin } from './plugins/TelegramPlugin';
import { CloudflarePlugin } from './plugins/CloudflarePlugin';
import { WeChatILinkPlugin } from './plugins/WeChatILinkPlugin';
import { errorText } from './plugins/shared';
import { Deliveries } from './plugins/Deliveries';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

const tabs = ['email', 'telegram', 'wechat_ilink', 'cloudflare', 'deliveries'] as const;

export function Plugins({ connection, close }: { connection: Connection; close: () => void }) {
  const [config, setConfig] = useState<Configs>();
  const [tab, setTab] = useState<keyof Configs | 'deliveries'>('email');
  const [status, setStatus] = useState('');
  const [mailStatus, setMailStatus] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      const data = await api<{ config: Configs; telegramStatus: string; emailStatus: string }>(connection, '/plugins');
      setConfig(data.config);
      setStatus(data.telegramStatus);
      setMailStatus(data.emailStatus);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    void load();
  }, [connection]);

  useEffect(() => {
    const timer = setInterval(() => {
      void api<{ telegramStatus: string; emailStatus: string }>(connection, '/plugins')
        .then(d => {
          setStatus(d.telegramStatus);
          setMailStatus(d.emailStatus);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [connection]);

  return (
    <main className="plugins">
      <header className="plugins-header">
        <div>
          <Logo size={24} />
          <h1>Plugins & cloud services</h1>
        </div>
        <Button variant="outline" onClick={close}>
          Back to chat
        </Button>
      </header>
      <Tabs value={tab} onValueChange={value => setTab(value as typeof tab)}>
        <TabsList aria-label="Connections">
          {tabs.map(name => (
            <TabsTrigger key={name} value={name}>
              {name === 'email'
                ? 'Email plugin'
                : name === 'telegram'
                ? 'Telegram'
                : name === 'wechat_ilink'
                ? 'WeChat (iLink)'
                : name === 'cloudflare'
                ? 'Cloudflare'
                : 'Deliveries'}
            </TabsTrigger>
          ))}
        </TabsList>
        {error && <p role="alert">{error}</p>}
        {!config ? (
          <Button onClick={() => void load()}>Retry</Button>
        ) : (
          <>
            {/* Keep plugin state mounted so tab switches retain unsaved edits. */}
            <TabsContent value="email" forceMount hidden={tab !== 'email'}><EmailPlugin connection={connection} initial={config.email} active={tab === 'email'} status={mailStatus} /></TabsContent>
            <TabsContent value="telegram" forceMount hidden={tab !== 'telegram'}><TelegramPlugin connection={connection} initial={config.telegram} active={tab === 'telegram'} status={status} /></TabsContent>
            <TabsContent value="wechat_ilink" forceMount hidden={tab !== 'wechat_ilink'}><WeChatILinkPlugin connection={connection} initial={config.wechat_ilink} active={tab === 'wechat_ilink'} /></TabsContent>
            <TabsContent value="cloudflare" forceMount hidden={tab !== 'cloudflare'}><CloudflarePlugin connection={connection} initial={config.cloudflare} active={tab === 'cloudflare'} /></TabsContent>
          </>
        )}
        <TabsContent value="deliveries"><Deliveries connection={connection} /></TabsContent>
      </Tabs>
    </main>
  );
}
