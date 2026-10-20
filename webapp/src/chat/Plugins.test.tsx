import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Plugins } from './Plugins';
import type { Configs } from './plugins/types';

const connection = { url: 'http://localhost', token: 'local-token' };
const initial = (): Configs => ({
  email: { enabled: true, from: 'a@example.org', imap: { host: 'imap.example.org', port: 993, security: 'tls', username: 'a', hasPassword: true }, smtp: { host: 'smtp.example.org', port: 587, security: 'starttls', username: 'a', hasPassword: true }, channel: { enabled: false, owner: '', verifier: '' } },
  telegram: { enabled: false, userId: 0 },
  cloudflare: { enabled: false, accountId: '', model: '', embeddingModel: '', index: '', databaseId: '', namespaceId: '', bucket: '' },
  wechat_ilink: { enabled: false, baseUrl: '', allowedUsers: [] },
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps saved passwords hidden, saves configuration and requires review before sending', async () => {
  let config = initial();
  const send = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/plugins/email/send')) { send(JSON.parse(options!.body as string)); return Response.json({ sent: true }); }
    if (url.endsWith('/plugins/email')) { config = { ...config, email: JSON.parse(options!.body as string) }; return Response.json(config); }
    return Response.json({ config, telegramStatus: 'Disabled' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  const secret = await screen.findByLabelText(/IMAP password/);
  expect(secret.getAttribute('type')).toBe('password');
  expect((secret as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('From address'), { target: { value: 'b@example.org' } });
  fireEvent.click(screen.getByText('Save configuration'));
  await screen.findByText('Configuration saved.');
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'recipient@example.org' } });
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'hello' } });
  fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'body' } });
  fireEvent.click(screen.getByText('Review email'));
  expect(send).not.toHaveBeenCalled();
  await screen.findByRole('region', { name: 'Review email' });
  fireEvent.click(screen.getByText('Send email'));
  await screen.findByText('Email accepted by SMTP.');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({ to: 'recipient@example.org', subject: 'hello', text: 'body' });
  expect(send.mock.calls[0][0].requestId).toHaveLength(32);
});
it('saves who Mob answers mail from and shows the channel status', async () => {
  let config = initial();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/plugins/email')) { config = { ...config, email: JSON.parse(options!.body as string) }; return Response.json(config); }
    return Response.json({ config, telegramStatus: 'Disabled', emailStatus: 'Connected · answering mail from me@example.org' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  fireEvent.click(await screen.findByLabelText("Answer the owner's mail"));
  fireEvent.change(screen.getByLabelText("Owner's address"), { target: { value: 'me@example.org' } });
  fireEvent.change(screen.getByLabelText(/Provider's authserv-id/), { target: { value: 'mx.example.org' } });
  fireEvent.click(screen.getByText('Save configuration'));
  await screen.findByText('Configuration saved.');
  expect(config.email.channel).toEqual({ enabled: true, owner: 'me@example.org', verifier: 'mx.example.org' });
  expect(config.email.from).toBe('a@example.org');
  await screen.findByText('Connected · answering mail from me@example.org');
});
it('tests Telegram and runs a Cloudflare operation using only saved configuration', async () => {
  const config = initial(); config.telegram = { enabled: true, userId: 42 }; config.cloudflare.enabled = true;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/test')) return Response.json({ username: 'fixture' });
    if (url.endsWith('/action')) { expect(JSON.parse(options!.body as string).operation).toBe('ai.models'); return Response.json([{ name: '@cf/model' }]); }
    return Response.json({ config, telegramStatus: 'Connected' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  await screen.findByLabelText('From address');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telegram' }), { button: 0, ctrlKey: false });
  expect(screen.getByLabelText(/Bot Token/).getAttribute('type')).toBe('password');
  fireEvent.click(screen.getByText('Test saved configuration'));
  await screen.findByText('Connection test passed.');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cloudflare' }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByText('Run ai.models'));
  await waitFor(() => expect(screen.getByLabelText('Operation result').textContent).toContain('@cf/model'));
  expect(calls).toContain('http://localhost/api/plugins/telegram/test');
});

it('tests WeChat iLink plugin tab and configuration rendering', async () => {
  const config = initial(); config.wechat_ilink = { enabled: true, baseUrl: 'https://ilinkai.weixin.qq.com' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/test')) return Response.json({ status: 'ready', channel: 'wechat-ilink' });
    return Response.json({ config, telegramStatus: 'Disabled' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  await screen.findByLabelText('From address');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'WeChat (iLink)' }), { button: 0, ctrlKey: false });
  expect(screen.getByLabelText(/iLink Base URL/)).toBeDefined();
  expect(screen.getByText('Get Login QR Code')).toBeDefined();
  fireEvent.click(screen.getByText('Test saved configuration'));
  await screen.findByText('Connection test passed.');
});

it('encodes the WeChat login link as a local QR image', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/qrcode')) return Response.json({
      qrcode: 'qr_test_abc',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/?k=fixture',
    });
    return Response.json({ config: initial(), telegramStatus: 'Disabled' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  await screen.findByLabelText('From address');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'WeChat (iLink)' }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByText('Get Login QR Code'));
  const qr = await screen.findByRole('img', { name: 'WeChat Login QR Code' });
  expect(qr.tagName.toLowerCase()).toBe('svg');
  expect(qr.querySelector('path')?.getAttribute('d')).toBeTruthy();
  expect(qr.getAttribute('src')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Please scan');
});

it('asks the user to save confirmed WeChat credentials before claiming they are saved', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const config = initial();
  const saved = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/qrcode')) return Response.json({ qrcode: 'login', qrcode_img_content: 'https://example.org/login' });
    if (url.includes('/qrcode/status?')) return Response.json({ status: 'confirmed', bot_token: 'fixture-token', ilink_bot_id: 'fixture-bot' });
    if (url.endsWith('/plugins/wechat_ilink')) {
      saved(JSON.parse(options!.body as string));
      return Response.json({ ...config, wechat_ilink: { enabled: true, botId: 'fixture-bot', hasToken: true } });
    }
    return Response.json({ config, telegramStatus: 'Disabled' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  await screen.findByLabelText('From address');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'WeChat (iLink)' }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByText('Get Login QR Code'));
  await screen.findByRole('img', { name: 'WeChat Login QR Code' });
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByText('WeChat authorization confirmed. Save configuration to finish connecting.')).toBeDefined();
  expect(screen.queryByText(/Token saved/)).toBeNull();
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Save configuration'));
  await screen.findByText('Configuration saved.');
  expect(saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true, botToken: 'fixture-token', botId: 'fixture-bot' }));
});

it('preserves email edits across plugin navigation and displays durable delivery state', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/deliveries')) return Response.json([{ id: 'email:fixture', state: 'failed-or-unknown', error: 'connection interrupted', reply: '', updatedAt: 1 }]);
    return Response.json({ config: initial(), telegramStatus: 'Disabled' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  fireEvent.change(await screen.findByLabelText('From address'), { target: { value: 'unsaved@example.org' } });
  const emailTab = screen.getByRole('tab', { name: 'Email plugin' });
  act(() => emailTab.focus());
  fireEvent.keyDown(emailTab, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Telegram' }).getAttribute('aria-selected')).toBe('true'));
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Telegram' }).id);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Email plugin' }), { button: 0, ctrlKey: false });
  expect((screen.getByLabelText('From address') as HTMLInputElement).value).toBe('unsaved@example.org');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Deliveries' }), { button: 0, ctrlKey: false });
  await screen.findByText(/failed-or-unknown/);
  expect(screen.getByText('connection interrupted')).toBeDefined();
});
