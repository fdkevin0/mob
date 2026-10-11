import { useEffect, useState } from 'react';
import { api, type Connection } from './api';
import type { Configs } from './plugins/types';
import { EmailPlugin } from './plugins/EmailPlugin';
import { TelegramPlugin } from './plugins/TelegramPlugin';
import { CloudflarePlugin } from './plugins/CloudflarePlugin';
import { WeChatILinkPlugin } from './plugins/WeChatILinkPlugin';
import { errorText } from './plugins/shared';
import { Deliveries } from './plugins/Deliveries';

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
      <header>
        <div>
          <p className="eyebrow">MOB / CONNECTIONS</p>
          <h1>Plugins & cloud services</h1>
        </div>
        <button className="secondary" onClick={close}>
          Back to chat
        </button>
      </header>
      <nav className="plugin-tabs" aria-label="Connections">
        {(['email', 'telegram', 'wechat_ilink', 'cloudflare', 'deliveries'] as const).map(name => (
          <button
            key={name}
            aria-current={tab === name ? 'page' : undefined}
            onClick={() => setTab(name)}
          >
            {name === 'email'
              ? 'Email plugin'
              : name === 'telegram'
              ? 'Telegram'
              : name === 'wechat_ilink'
              ? 'WeChat (iLink)'
              : name === 'cloudflare'
              ? 'Cloudflare'
              : 'Deliveries'}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {!config ? (
        <button onClick={() => void load()}>Retry</button>
      ) : (
        <>
          <EmailPlugin connection={connection} initial={config.email} active={tab === 'email'} status={mailStatus} />
          <TelegramPlugin connection={connection} initial={config.telegram} active={tab === 'telegram'} status={status} />
          <WeChatILinkPlugin connection={connection} initial={config.wechat_ilink} active={tab === 'wechat_ilink'} />
          <CloudflarePlugin connection={connection} initial={config.cloudflare} active={tab === 'cloudflare'} />
        </>
      )}
      {tab === 'deliveries' && <Deliveries connection={connection} />}
    </main>
  );
}
