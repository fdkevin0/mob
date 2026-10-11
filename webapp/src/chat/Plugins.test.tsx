import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Plugins } from './Plugins';
import type { Configs } from './plugins/types';

const connection = { url: 'http://localhost', token: 'local-token' };
const initial = (): Configs => ({
  email: { enabled: true, from: 'a@example.org', imap: { host: 'imap.example.org', port: 993, security: 'tls', username: 'a', hasPassword: true }, smtp: { host: 'smtp.example.org', port: 587, security: 'starttls', username: 'a', hasPassword: true } },
  telegram: { enabled: false, userId: 0 },
  cloudflare: { enabled: false, useForChat: false, accountId: '', model: '', embeddingModel: '', index: '', databaseId: '', namespaceId: '', bucket: '' },
  wechat_ilink: { enabled: false, baseUrl: '', allowedUsers: [] },
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
  fireEvent.click(screen.getByText('Telegram', { selector: 'button' }));
  expect(screen.getByLabelText(/Bot Token/).getAttribute('type')).toBe('password');
  fireEvent.click(screen.getByText('Test saved configuration'));
  await screen.findByText('Connection test passed.');
  fireEvent.click(screen.getByText('Cloudflare', { selector: 'button' }));
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
  fireEvent.click(screen.getByText('WeChat (iLink)', { selector: 'button' }));
  expect(screen.getByLabelText(/iLink Base URL/)).toBeDefined();
  expect(screen.getByText('Get Login QR Code')).toBeDefined();
  fireEvent.click(screen.getByText('Test saved configuration'));
  await screen.findByText('Connection test passed.');
});

it('preserves email edits across plugin navigation and displays durable delivery state', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/deliveries')) return Response.json([{ id: 'email:fixture', state: 'failed-or-unknown', error: 'connection interrupted', reply: '', updatedAt: 1 }]);
    return Response.json({ config: initial(), telegramStatus: 'Disabled' });
  }));
  render(<Plugins connection={connection} close={() => {}} />);
  fireEvent.change(await screen.findByLabelText('From address'), { target: { value: 'unsaved@example.org' } });
  fireEvent.click(screen.getByText('Telegram', { selector: 'button' }));
  fireEvent.click(screen.getByText('Email plugin', { selector: 'button' }));
  expect((screen.getByLabelText('From address') as HTMLInputElement).value).toBe('unsaved@example.org');
  fireEvent.click(screen.getByText('Deliveries', { selector: 'button' }));
  await screen.findByText(/failed-or-unknown/);
  expect(screen.getByText('connection interrupted')).toBeDefined();
});
