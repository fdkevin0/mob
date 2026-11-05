import { Button } from '@mob/ui/button';
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, type Connection } from '../api';
import { ClearSecrets, SchemaFields, schemas } from './SchemaFields';
import { Field, Feedback, Result, Actions, errorText, usePlugin } from './shared';
import type { WeChatILinkConfig } from './types';

export function WeChatILinkPlugin({ connection, initial, active }: { connection: Connection; initial?: WeChatILinkConfig; active: boolean }) {
  const { config, setConfig, busy, error, setError, notice, setNotice, result, save, test, unavailable, clearSecret, secrets } = usePlugin(
    'wechat_ilink',
    initial || { enabled: false },
    connection
  );

  const [qrCode, setQrCode] = useState<{ qrcode: string; content: string } | null>(null);
  const [qrStatus, setQrStatus] = useState<string>('');
  const [fetchingQR, setFetchingQR] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  if (!active) return null;

  async function requestQRCode() {
    try {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      setFetchingQR(true);
      setError('');
      setQrStatus('Fetching QR Code from WeChat iLink API...');
      const res = await api<{ qrcode: string; qrcode_img_content: string }>(connection, '/plugins/wechat_ilink/qrcode', {});
      setQrCode({ qrcode: res.qrcode, content: res.qrcode_img_content });
      setQrStatus('Please scan the QR code using WeChat on your mobile device...');

      timerRef.current = setInterval(async () => {
        try {
          const statusRes = await api<{ status: string; bot_token?: string; ilink_bot_id?: string }>(
            connection,
            `/plugins/wechat_ilink/qrcode/status?qrcode=${encodeURIComponent(res.qrcode)}`
          );
          if (statusRes.status === 'confirmed') {
            if (timerRef.current) {
              clearInterval(timerRef.current);
            }
            setQrStatus('Scan confirmed. Credentials are not saved yet.');
            setConfig(prev => ({
              ...prev,
              enabled: true,
              botToken: statusRes.bot_token || prev.botToken,
              botId: statusRes.ilink_bot_id || prev.botId,
            }));
            setQrCode(null);
            setNotice('WeChat authorization confirmed. Save configuration to finish connecting.');
          } else if (statusRes.status === 'expired') {
            if (timerRef.current) {
              clearInterval(timerRef.current);
            }
            setQrStatus('QR Code expired. Please click to request a new one.');
          }
        } catch {
          // ignore transient poll error
        }
      }, 3000);
    } catch (e: unknown) {
      setQrStatus(`Failed to fetch QR Code: ${errorText(e)}`);
    } finally {
      setFetchingQR(false);
    }
  }

  return (
    <>
      <Feedback error={error} notice={notice} />
      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <SchemaFields schema={schemas.wechat_ilink} value={config} onChange={v => setConfig(v as WeChatILinkConfig)} keys={['enabled']} />
          <p>
            Connect to WeChat via the official WeChat iLink Bot API (<code>ilinkai.weixin.qq.com</code>).
            Supports personal WeChat QR code scan authorization, HTTP long-polling message receipt, and in-band tool approvals.
          </p>

          <div className="qr-section">
            <h4>WeChat Scan Authorization</h4>
            <p className="muted">Generate a temporary authorization QR code for your WeChat account.</p>
            <Button type="button" disabled={fetchingQR} onClick={() => void requestQRCode()}>
              {fetchingQR ? 'Generating QR Code...' : 'Get Login QR Code'}
            </Button>
            {qrStatus && <p role="status">{qrStatus}</p>}
            {qrCode && qrCode.content && (
              <div>
                <QRCodeSVG value={qrCode.content} size={200} marginSize={4} role="img" title="WeChat Login QR Code" />
              </div>
            )}
          </div>

          <SchemaFields schema={schemas.wechat_ilink} value={config} onChange={v => setConfig(v as WeChatILinkConfig)} keys={['baseUrl', 'botToken']} />
          <Field
            label="Bot ID"
            value={config.botId || ''}
            hint="Assigned upon WeChat scan confirmation, or enter manually."
            onChange={v => setConfig({ ...config, botId: v })}
          />
          <Field
            label="Allowed WeChat User IDs (comma-separated)"
            value={(config.allowedUsers || []).join(', ')}
            hint="Leave blank to accept messages from any paired user, or restrict to specific WeChat user IDs."
            onChange={v => setConfig({ ...config, allowedUsers: v.split(',').map(s => s.trim()).filter(Boolean) })}
          />
          <ClearSecrets schema={schemas.wechat_ilink} enabled={config.enabled} secrets={secrets} clear={clearSecret} />
          <Actions busy={busy} unavailable={unavailable} test={test} />
        </fieldset>
      </form>
      <Result value={result} />
    </>
  );
}
