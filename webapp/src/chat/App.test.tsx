import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.go; localStorage.clear(); sessionStorage.clear(); });

it('opens chat without key setup and shows the conversation model', async () => {
  window.go = { main: { Desktop: { Connection: async () => ({ url: 'http://localhost', token: 'token' }) } } };
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url.endsWith('/config')) return Response.json({ defaultModel: 'opencode/mimo-v2.6-flash-free', demo: false });
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model: 'deepseek/deepseek-chat' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByLabelText('Message');
  await waitFor(() => expect(screen.getByText('deepseek/deepseek-chat')).toBeTruthy());
  expect(screen.queryByLabelText('API key')).toBeNull();
  expect(fetchMock.mock.calls.some(([, options]) => String(options?.body ?? '').includes('apiKey'))).toBe(false);
});

it('promises no model calls only when the conversation uses the demo model', async () => {
  window.go = { main: { Desktop: { Connection: async () => ({ url: 'http://localhost', token: 'token' }) } } };
  let model = 'demo/echo';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model });
  }));
  render(<App />);
  await screen.findByText('Demo mode · no model calls');
  cleanup();
  model = 'deepseek/deepseek-chat';
  render(<App />);
  await screen.findByText('deepseek/deepseek-chat');
  expect(screen.queryByText('Demo mode · no model calls')).toBeNull();
});

it('shows why the desktop could not start instead of asking for a token', async () => {
  const reason = 'This database has schema 1, last opened by an unknown release. Install Mob 20261011.bbbbbbb from https://github.com/fdkevin0/mob/releases/tag/20261011.bbbbbbb, start it once to upgrade the database, then start Mob 20261101.ddddddd again.';
  window.go = { main: { Desktop: { Connection: async () => { throw reason; } } } };
  render(<App />);
  expect((await screen.findByRole('alert')).textContent).toBe(reason);
  expect(screen.getByText('Mob could not start.')).toBeTruthy();
  expect(screen.queryByLabelText('Local access token')).toBeNull();
});

it('signs in once with the link mob open prints and keeps the token across visits', async () => {
  window.history.replaceState(null, '', '/#pair=code-1');
  let claims = 0;
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/pairing/claim')) { claims++; expect(JSON.parse(String(options?.body))).toEqual({ code: 'code-1' }); return Response.json({ token: 'paired' }); }
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByRole('button', { name: /disconnect/i });
  expect(window.location.hash).toBe('');
  expect(localStorage.getItem('mob-token')).toBe('paired');
  const authorized = fetchMock.mock.calls.filter(([url]) => !url.endsWith('/pairing/claim'));
  expect(authorized.every(([, options]) => new Headers(options?.headers).get('Authorization') === 'Bearer paired')).toBe(true);
  cleanup();
  render(<App />);
  await screen.findByRole('button', { name: /disconnect/i });
  expect(claims).toBe(1);
  screen.getByRole('button', { name: /disconnect/i }).click();
  await screen.findByLabelText('Local access token');
  expect(localStorage.getItem('mob-token')).toBeNull();
});

it('explains an expired pairing link and offers the token form', async () => {
  window.history.replaceState(null, '', '/#pair=stale');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('pairing code is invalid or expired; run mob open again', { status: 403 })));
  render(<App />);
  expect((await screen.findByRole('alert')).textContent).toContain('run mob open again');
  expect(screen.getByLabelText('Local access token')).toBeTruthy();
  expect(localStorage.getItem('mob-token')).toBeNull();
});

it('returns to sign-in when a saved token was replaced', async () => {
  localStorage.setItem('mob-token', 'revoked');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
  render(<App />);
  expect((await screen.findByRole('alert')).textContent).toContain('Run mob open');
  expect(screen.getByLabelText('Local access token')).toBeTruthy();
  expect(localStorage.getItem('mob-token')).toBeNull();
});

it('signs out an open workspace when the token is rotated', async () => {
  localStorage.setItem('mob-token', 'current');
  let rotated = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (rotated) return new Response('unauthorized', { status: 401 });
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  }));
  render(<App />);
  await screen.findByRole('button', { name: /disconnect/i });
  rotated = true;
  screen.getByRole('button', { name: /new/i }).click();
  await screen.findByLabelText('Local access token');
  expect(localStorage.getItem('mob-token')).toBeNull();
});

it('ignores a late 401 for a token that was already replaced', async () => {
  localStorage.setItem('mob-token', 'replacement');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  }));
  render(<App />);
  await screen.findByRole('button', { name: /disconnect/i });
  window.dispatchEvent(new CustomEvent('mob:unauthorized', { detail: 'old' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.getByRole('button', { name: /disconnect/i })).toBeTruthy();
  expect(localStorage.getItem('mob-token')).toBe('replacement');
});

it('keeps a replacement token another tab saved when this tab signs out', async () => {
  localStorage.setItem('mob-token', 'old');
  let rotated = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (rotated) return new Response('unauthorized', { status: 401 });
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  }));
  render(<App />);
  await screen.findByRole('button', { name: /disconnect/i });
  localStorage.setItem('mob-token', 'replacement');
  rotated = true;
  screen.getByRole('button', { name: /new/i }).click();
  await screen.findByLabelText('Local access token');
  expect(localStorage.getItem('mob-token')).toBe('replacement');
});

const offer = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

it('signs the public web in to local Mob with a mob open --web link and remembers where it is', async () => {
  vi.stubEnv('MODE', 'public');
  window.history.replaceState(null, '', `/#offer=${offer({ v: 1, url: 'http://127.0.0.1:9000', code: 'code-1' })}`);
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    expect(url.startsWith('http://127.0.0.1:9000/api/')).toBe(true);
    if (url.endsWith('/pairing/claim')) { expect(JSON.parse(String(options?.body))).toEqual({ code: 'code-1' }); return Response.json({ token: 'paired' }); }
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    await screen.findByRole('button', { name: /disconnect/i });
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem('mob-url')).toBe('http://127.0.0.1:9000');
    cleanup();
    render(<App />);
    await screen.findByRole('button', { name: /disconnect/i });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/pairing/claim'))).toHaveLength(1);
  } finally { vi.unstubAllEnvs(); }
});

it('ignores a public web link that points to another computer', async () => {
  vi.stubEnv('MODE', 'public');
  window.history.replaceState(null, '', `/#offer=${offer({ v: 1, url: 'https://evil.example', code: 'code-1' })}`);
  const fetchMock = vi.fn(async () => Response.json({ token: 'stolen' }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('another computer');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Mob address')).toBeTruthy();
    expect(localStorage.getItem('mob-url')).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});

it('explains why the public web could not reach local Mob', async () => {
  vi.stubEnv('MODE', 'public');
  window.history.replaceState(null, '', `/#offer=${offer({ v: 1, url: 'http://localhost:8787', code: 'code-1' })}`);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  try {
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('could not reach Mob at http://localhost:8787');
  } finally { vi.unstubAllEnvs(); }
});
