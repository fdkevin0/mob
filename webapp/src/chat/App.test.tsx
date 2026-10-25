import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
// Local pairing tests keep runner discovery isolated; Runners.test.tsx covers that flow.
vi.mock('./Runners', () => ({ Runners: () => null }));
// The browser runner's worker is replaced by whatever fetch a test stubs.
vi.mock('./browser/browser', () => ({ startBrowser: async () => ({ persistent: true }), browserFetch: (input: string, init?: RequestInit) => fetch(input, init) }));
import { App } from './App';
import { chooseFromRunnerMenu } from './runnerMenu.test-helper';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.mobDesktop; localStorage.clear(); sessionStorage.clear(); });

it('opens chat without key setup and shows the conversation model', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url.endsWith('/config')) return Response.json({ defaultModel: 'opencode/mimo-v2.6-flash-free', demo: false });
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model: 'deepseek/deepseek-chat' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByLabelText('Message');
  await waitFor(() => expect(screen.getByRole('button', { name: 'deepseek/deepseek-chat' }).querySelector('.model-label')?.textContent).toBe('deepseek-chat'));
  expect(screen.queryByLabelText('API key')).toBeNull();
  expect(fetchMock.mock.calls.some(([, options]) => String(options?.body ?? '').includes('apiKey'))).toBe(false);
});

it('promises no model calls only when the conversation uses the demo model', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
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
  await screen.findByRole('button', { name: 'deepseek/deepseek-chat' });
  expect(screen.queryByText('Demo mode · no model calls')).toBeNull();
});

it('shows why the desktop could not start instead of asking for a token', async () => {
  const reason = 'This database has schema 1, last opened by an unknown release. Install Mob 20261011.bbbbbbb from https://github.com/fdkevin0/mob/releases/tag/20261011.bbbbbbb, start it once to upgrade the database, then start Mob 20261101.ddddddd again.';
  window.mobDesktop = { connection: async () => { throw reason; } };
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
    if (url.endsWith('/conversations')) return Response.json(options?.method === 'POST' ? { id: 'new', title: 'New conversation' } : []);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByRole('button', { name: /settings and runner/ });
  expect(window.location.hash).toMatch(/^#\/c\/[0-9a-f]{32}$/);
  expect(localStorage.getItem('mob-token')).toBe('paired');
  const authorized = fetchMock.mock.calls.filter(([url]) => !url.endsWith('/pairing/claim'));
  expect(authorized.every(([, options]) => new Headers(options?.headers).get('Authorization') === 'Bearer paired')).toBe(true);
  cleanup();
  render(<App />);
  await screen.findByRole('button', { name: /settings and runner/ });
  expect(claims).toBe(1);
  await chooseFromRunnerMenu('Disconnect');
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
  await screen.findByRole('button', { name: /settings and runner/ });
  rotated = true;
  screen.getAllByRole('button', { name: /new/i })[0].click();
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
  await screen.findByRole('button', { name: /settings and runner/ });
  window.dispatchEvent(new CustomEvent('mob:unauthorized', { detail: 'old' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.getByRole('button', { name: /settings and runner/ })).toBeTruthy();
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
  await screen.findByRole('button', { name: /settings and runner/ });
  localStorage.setItem('mob-token', 'replacement');
  rotated = true;
  screen.getAllByRole('button', { name: /new/i })[0].click();
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
    if (url.endsWith('/conversations')) return Response.json(options?.method === 'POST' ? { id: 'new', title: 'New conversation' } : []);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    await screen.findByRole('button', { name: /settings and runner/ });
    expect(window.location.hash).toMatch(/^#\/c\/[0-9a-f]{32}$/);
    expect(localStorage.getItem('mob-url')).toBe('http://127.0.0.1:9000');
    cleanup();
    render(<App />);
    await screen.findByRole('button', { name: /settings and runner/ });
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

it('sends a typed token from the public web only to Mob on this computer', async () => {
  vi.stubEnv('MODE', 'public');
  localStorage.setItem('mob-url', 'https://mob.example');
  const fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith('/conversations') ? [] : {}));
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    await screen.findByRole('button', { name: 'This browser: settings and runner' });
    await chooseFromRunnerMenu('Connect a runner');
    fireEvent.click(await screen.findByRole('button', { name: /Your own runner/ }));
    const address = await screen.findByLabelText('Mob address') as HTMLInputElement;
    expect(address.value).toBe('http://127.0.0.1:8787');
    fireEvent.change(address, { target: { value: 'https://mob.example' } });
    fireEvent.change(screen.getByLabelText('Local access token'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Mob on this computer');
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith('http://localhost/api/'))).toBe(true);
  } finally { vi.unstubAllEnvs(); }
});

it('keeps the browser workspace when choosing the current runner or a connection fails', async () => {
  vi.stubEnv('MODE', 'public');
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url.startsWith('http://localhost/api/')).toBe(true);
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return init?.method === 'POST' ? Response.json({ id: 'new', title: 'New conversation' }) : Response.json([]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    await screen.findByRole('button', { name: 'This browser: settings and runner' });
    expect(screen.queryByRole('button', { name: 'Plugins & cloud services' })).toBeNull();
    const limits = await screen.findByRole('region', { name: 'What Mob in this browser cannot do' });
    expect(limits.textContent).toContain('Coding agents');
    fireEvent.click(within(limits).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('region', { name: 'What Mob in this browser cannot do' })).toBeNull();
    expect(localStorage.getItem('mob-browser-limits-seen')).toBe('1');
    await chooseFromRunnerMenu('What needs a runner');
    await screen.findByRole('region', { name: 'What Mob in this browser cannot do' });
    const token = localStorage.getItem('mob-browser-token');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    fireEvent.click(screen.getAllByRole('button', { name: 'New conversation' })[0]);
    const composer = await screen.findByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Keep this draft' } });
    const hash = window.location.hash;
    await chooseFromRunnerMenu('Connect a runner');
    let dialog = await screen.findByRole('dialog', { name: 'Connect a runner' });
    expect(localStorage.getItem('mob-browser-last')).toBe('1');
    expect(composer.isConnected).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /This browser/ }));
    await act(async () => {});
    expect(screen.getByLabelText('Message')).toBe(composer);
    expect(composer.value).toBe('Keep this draft');
    expect(window.location.hash).toBe(hash);
    // A failed connection must leave the current workspace and draft intact too.
    await chooseFromRunnerMenu('Connect a runner');
    dialog = await screen.findByRole('dialog', { name: 'Connect a runner' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Your own runner/ }));
    fireEvent.change(within(dialog).getByLabelText('Local access token'), { target: { value: 'runner-token' } });
    fetchMock.mockImplementationOnce(async () => new Response('Runner unavailable', { status: 503 }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open workspace' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Runner unavailable');
    expect(composer.isConnected).toBe(true);
    expect(composer.value).toBe('Keep this draft');
    expect(localStorage.getItem('mob-browser-last')).toBe('1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    cleanup();
    render(<App />);
    await screen.findByRole('button', { name: 'This browser: settings and runner' });
    expect(localStorage.getItem('mob-browser-token')).toBe(token);
  } finally { vi.unstubAllEnvs(); }
});

it.each([200, 503])('ignores a dismissed connection returning %i while a newer attempt is pending', async (status) => {
  vi.stubEnv('MODE', 'public');
  const requests: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('http://127.0.0.1:8787/') && url.endsWith('/config')) {
      return new Promise<Response>(resolve => requests.push(resolve));
    }
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([]);
    return Response.json({ messages: [], active: false, model: 'demo/echo' });
  }));
  try {
    render(<App />);
    await screen.findByRole('button', { name: 'This browser: settings and runner' });
    fireEvent.click(screen.getAllByRole('button', { name: 'New conversation' })[0]);
    const composer = await screen.findByLabelText('Message') as HTMLTextAreaElement;
    await chooseFromRunnerMenu('Connect a runner');
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Your own runner/ }));
    fireEvent.change(within(dialog).getByLabelText('Local access token'), { target: { value: 'old-token' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open workspace' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.change(composer, { target: { value: 'Still typing after closing' } });
    await chooseFromRunnerMenu('Connect a runner');
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Your own runner/ }));
    fireEvent.change(within(dialog).getByLabelText('Local access token'), { target: { value: 'new-token' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open workspace' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => { requests[0](new Response(status === 200 ? '{}' : 'Old failure', { status })); });
    expect(composer.isConnected).toBe(true);
    expect(composer.value).toBe('Still typing after closing');
    expect(localStorage.getItem('mob-token')).toBeNull();
    expect(localStorage.getItem('mob-browser-last')).toBe('1');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { requests[1](Response.json({})); });
    await screen.findByRole('button', { name: 'This computer: settings and runner' });
    expect(localStorage.getItem('mob-token')).toBe('new-token');
    expect(localStorage.getItem('mob-browser-last')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});

it('opens the current workspace even with the retired browser-off preference', async () => {
  vi.stubEnv('MODE', 'public');
  localStorage.setItem('mob-browser-off', '1');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/conversations') ? [] : {})));
  try {
    render(<App />);
    await screen.findByRole('button', { name: 'This browser: settings and runner' });
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('mob-browser-last')).toBe('1');
  } finally { vi.unstubAllEnvs(); }
});

it('offers the connection screen after disconnecting and can reopen the browser workspace', async () => {
  vi.stubEnv('MODE', 'public');
  localStorage.setItem('mob-token', 'local-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/conversations') ? [] : {})));
  try {
    render(<App />);
    await screen.findByRole('button', { name: 'This computer: settings and runner' });
    await chooseFromRunnerMenu('Disconnect');
    expect(screen.queryByRole('searchbox', { name: 'Search conversations' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a runner' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /This browser/ }));
    await screen.findByRole('button', { name: 'This browser: settings and runner' });
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});

it('offers to continue a reply that stopped at the tool step limit', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  const chats: string[] = [];
  const messages = [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'fix it' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'working' }], metadata: { status: 'step-limit', error: 'tool step limit reached (20); send another message to continue' } },
  ];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/runtime')) return Promise.resolve(Response.json({ background: false }));
    if (url.endsWith('/conversations')) return Promise.resolve(Response.json([{ id: 'one', title: 'Existing' }]));
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages, active: false, model: 'demo/echo' }));
  }));
  render(<App />);
  const editor = await screen.findByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'Keep my unsent 草稿' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(chats.some(c => c.includes('"text":"Continue"'))).toBe(true));
  expect(chats.map(body => JSON.parse(body).text)).toEqual(['Continue']);
  expect(editor.value).toBe('Keep my unsent 草稿');
});

it('ends a streamed turn that reached the step limit with Continue, not an error', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  let sent = false;
  const saved = [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'fix it' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'working' }], metadata: { status: 'step-limit', error: 'tool step limit reached (20); send another message to continue' } },
  ];
  const stream = ['{"type":"start","messageId":"a"}', '{"type":"start-step"}', '{"type":"text-start","id":"t"}', '{"type":"text-delta","id":"t","delta":"working"}',
    '{"type":"text-end","id":"t"}', '{"type":"finish-step"}', '{"type":"finish","finishReason":"tool-calls"}'].map(chunk => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n';
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/runtime')) return Promise.resolve(Response.json({ background: false }));
    if (url.endsWith('/conversations')) return Promise.resolve(Response.json([{ id: 'one', title: 'Existing' }]));
    if (url.endsWith('/chat')) { sent = true; return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })); }
    return Promise.resolve(Response.json({ messages: sent ? saved : [], active: false, model: 'demo/echo' }));
  }));
  render(<App />);
  const box = await screen.findByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'fix it' } });
  fireEvent.submit(box.closest('form')!);
  await screen.findByRole('button', { name: 'Continue' }, { timeout: 5000 });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(box.value).toBe('');
});

it('switches the conversation model from the header picker', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  let run: Record<string, unknown> | undefined;
  const fetchMock = vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/runtime')) return Promise.resolve(Response.json({ background: false }));
    if (url.endsWith('/config')) return Promise.resolve(Response.json({ defaultModel: 'opencode/mimo-v2.6-flash-free', demo: false }));
    if (url.endsWith('/conversations')) return Promise.resolve(Response.json([{ id: 'one', title: 'Existing' }]));
    if (url.endsWith('/models')) return Promise.resolve(Response.json([{ provider: 'deepseek', name: 'DeepSeek', models: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', tools: true },
      { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner', tools: true, reasoning: true },
    ] }]));
    if (url.endsWith('/commands/run')) { run = JSON.parse(String(options?.body)); return Promise.resolve(Response.json({ handled: false })); }
    if (url.endsWith('/chat')) return Promise.resolve(new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'deepseek/deepseek-chat' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  const trigger = await screen.findByRole('button', { name: 'deepseek/deepseek-chat' });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep my message' } });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Choose a model' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search models')));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByText('DeepSeek Reasoner'));
  await waitFor(() => expect(run).toBeDefined());
  expect(run).toMatchObject({ conversationId: 'one', text: '/model deepseek/deepseek-reasoner' });
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Keep my message');
  expect(screen.queryByRole('dialog', { name: 'Choose a model' })).toBeNull();
});

it('opens the conversation sheet and closes it after selecting a conversation', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/config')) return Response.json({});
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'First chat' }, { id: 'two', title: 'Second chat' }]);
    return Response.json({ messages: [], active: false, model: 'demo/offline' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByRole('button', { name: 'Demo mode · no model calls' });
  const trigger = screen.getByRole('button', { name: 'Conversations' });
  fireEvent.click(trigger);
  const sheet = await screen.findByRole('dialog', { name: 'Conversations' });
  expect(sheet.contains(document.activeElement)).toBe(true);
  fireEvent.click(within(sheet).getByRole('button', { name: 'Second chat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/conversations/two'))).toBe(true);
  expect(screen.getByRole('button', { name: 'Second chat' }).getAttribute('aria-current')).toBe('page');
});

it('opens Token usage while a command is on its way, and holds other conversations until Mob has it', async () => {
  window.history.replaceState(null, '', '/');
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  let answer: (r: Response) => void = () => {};
  let chat: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/runtime')) return Promise.resolve(Response.json({ background: false }));
    if (url.endsWith('/config')) return Promise.resolve(Response.json({ defaultModel: 'demo/echo', demo: false }));
    if (url.endsWith('/conversations')) return Promise.resolve(Response.json([{ id: 'one', title: 'Existing' }, { id: 'two', title: 'Other' }]));
    if (url.endsWith('/commands/run')) return new Promise<Response>((resolve) => { answer = resolve; });
    if (url.endsWith('/chat')) { chat = JSON.parse(String(options?.body)); return Promise.resolve(new Response('', { status: 500 })); }
    if (url.includes('/usage')) return Promise.resolve(Response.json({ totalTokens: 1, models: [], days: [], top: [{ id: 'two', title: 'Other', totalTokens: 1, inputTokens: 1, cacheReadTokens: 0, turns: 1, cost: 0 }] }));
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { container } = render(<App />);
  const box = await screen.findByLabelText('Message') as HTMLTextAreaElement;
  const usage = screen.getAllByRole('button', { name: 'Token usage' })[0] as HTMLButtonElement;
  // The list may be redrawn as it loads, so the button is looked up each time.
  const other = () => within(screen.getByRole('navigation', { name: 'Conversations' })).getByRole('button', { name: 'Other' }) as HTMLButtonElement;
  fireEvent.change(box, { target: { value: '/compact' } });
  fireEvent.submit(box.closest('form')!);
  // Leaving the conversation now could lose the command, but a page opens beside it.
  await waitFor(() => expect(other().disabled).toBe(true));
  expect(usage.disabled).toBe(false);
  fireEvent.click(usage);
  await screen.findByRole('heading', { name: 'Token usage' });
  // The page's own link to another conversation is held too.
  const link = await waitFor(() => container.querySelector<HTMLButtonElement>('.usage-link')!);
  expect(link.disabled).toBe(true);
  fireEvent.click(link);
  answer(Response.json({ handled: false }));
  await waitFor(() => expect(chat).toBeDefined());
  await waitFor(() => expect(other().disabled).toBe(false));
  expect(link.disabled).toBe(false);
  expect(window.location.hash).toBe('#/usage');
});

it('frees the sidebar when the open conversation is chosen again while another is still loading', async () => {
  window.history.replaceState(null, '', '/');
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  let releaseTwo!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }, { id: 'two', title: 'Other' }, { id: 'three', title: 'Third' }]);
    const id = url.match(/\/conversations\/(\w+)$/)?.[1];
    const snapshot = () => Response.json({ messages: [{ id: `m-${id}`, role: 'assistant', parts: [{ type: 'text', text: `reply in ${id}` }] }], active: false, model: 'demo/echo' });
    if (id === 'two') return new Promise<Response>(resolve => { releaseTwo = () => resolve(snapshot()); });
    if (id) return snapshot();
    return Response.json({});
  }));
  render(<App />);
  await screen.findByText('reply in one');
  const button = (name: string) => within(screen.getByRole('navigation', { name: 'Conversations' })).getByRole('button', { name }) as HTMLButtonElement;
  fireEvent.click(button('Other'));
  await waitFor(() => expect(releaseTwo).toBeDefined());
  await waitFor(() => expect(button('Third').disabled).toBe(true));
  fireEvent.click(button('Existing'));
  releaseTwo();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(window.location.hash).toBe('#/c/one');
  expect(button('Third').disabled).toBe(false);
  expect(button('Other').disabled).toBe(false);
  expect((screen.getAllByRole('button', { name: 'New conversation' })[0] as HTMLButtonElement).disabled).toBe(false);
  window.history.replaceState(null, '', '/');
});

it('shows the calf while it connects to Mob on this computer, not a form about to go away', async () => {
  window.history.replaceState(null, '', '/');
  localStorage.setItem('mob-token', 'saved');
  let answer!: (r: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/config')) return new Promise<Response>(resolve => { answer = resolve; });
    if (url.endsWith('/runtime')) return Promise.resolve(Response.json({ background: false }));
    if (url.endsWith('/conversations')) return Promise.resolve(Response.json([]));
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  render(<App />);
  expect((await screen.findByRole('status')).textContent).toContain('Connecting to Mob…');
  expect(screen.queryByRole('button', { name: /Open workspace|Connecting/ })).toBeNull();
  await waitFor(() => expect(answer).toBeDefined());
  answer(Response.json({ defaultModel: 'demo/echo' }));
  await screen.findByLabelText('Message');
});

it('starts a new conversation only with its first message, and renames and deletes conversations', async () => {
  window.history.replaceState(null, '', '/');
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  let list = [{ id: 'one', title: 'Existing' }, { id: 'two', title: 'Other' }];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/config')) return Response.json({ defaultModel: 'demo/echo' });
    if (url.endsWith('/conversations')) return Response.json(list);
    if (url.endsWith('/rename')) return Response.json({ title: 'Renamed' });
    if (url.endsWith('/delete')) { list = list.filter(c => !url.includes(`/conversations/${c.id}/`)); return Response.json({ deleted: true }); }
    if (url.endsWith('/chat')) return new Response('', { status: 500 });
    const id = url.match(/\/conversations\/(\w+)$/)?.[1];
    return Response.json({ messages: [{ id: `m-${id}`, role: 'assistant', parts: [{ type: 'text', text: `reply in ${id}` }] }], active: false, model: 'demo/echo' });
  }));
  render(<App />);
  await screen.findByText('reply in one');
  const nav = () => within(screen.getByRole('navigation', { name: 'Conversations' }));
  const menu = (title: string) => {
    fireEvent.keyDown(nav().getByRole('button', { name: `More for ${title}` }), { key: 'Enter' });
    return within(screen.getByRole('menu'));
  };

  fireEvent.click(menu('Other').getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByLabelText('Conversation title'), { target: { value: 'Renamed' } });
  fireEvent.submit(screen.getByLabelText('Conversation title').closest('form')!);
  expect(nav().getByRole('button', { name: 'Renamed' })).toBeTruthy();
  expect(posts).toContainEqual({ url: 'http://localhost/api/conversations/two/rename', body: { title: 'Renamed' } });

  // Deleting the open conversation asks first, then opens the next one.
  fireEvent.click(menu('Existing').getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this conversation?' });
  expect(dialog.textContent).toContain('“Existing” and its messages are deleted from this computer');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await screen.findByText('reply in two');
  expect(posts.some(p => p.url.endsWith('/conversations/one/delete'))).toBe(true);
  expect(nav().queryByRole('button', { name: 'Existing' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();

  // A new conversation is a draft until its first message names it to Mob.
  fireEvent.click(screen.getAllByRole('button', { name: 'New conversation' })[0]);
  await waitFor(() => expect(window.location.hash).toMatch(/^#\/c\/[0-9a-f]{32}$/));
  const id = window.location.hash.slice('#/c/'.length);
  expect(posts.some(p => p.url.endsWith('/api/conversations'))).toBe(false);
  const box = await screen.findByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'hello' } });
  fireEvent.submit(box.closest('form')!);
  await waitFor(() => expect(posts.find(p => p.url.endsWith('/api/chat'))?.body.id).toBe(id));
  window.history.replaceState(null, '', '/');
});

it('keeps a page open that was chosen while a conversation was still loading, and opens the conversation behind it', async () => {
  window.history.replaceState(null, '', '/');
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  let releaseTwo!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }, { id: 'two', title: 'Other' }]);
    if (url.includes('/usage')) return Response.json({ totalTokens: 0, models: [], days: [], top: [] });
    const id = url.match(/\/conversations\/(\w+)$/)?.[1];
    const snapshot = () => Response.json({ messages: [{ id: `m-${id}`, role: 'assistant', parts: [{ type: 'text', text: `reply in ${id}` }] }], active: false, model: 'demo/echo' });
    if (id === 'two') return new Promise<Response>(resolve => { releaseTwo = () => resolve(snapshot()); });
    if (id) return snapshot();
    return Response.json({});
  }));
  render(<App />);
  await screen.findByText('reply in one');
  fireEvent.click(screen.getByRole('button', { name: 'Other' }));
  await waitFor(() => expect(releaseTwo).toBeDefined());
  fireEvent.click(screen.getAllByRole('button', { name: 'Token usage' })[0]);
  await screen.findByRole('heading', { name: 'Token usage' });
  releaseTwo();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(window.location.hash).toBe('#/usage');
  expect(screen.getByRole('heading', { name: 'Token usage' })).toBeTruthy();
  // The conversation that loaded waits behind the page.
  fireEvent.click(screen.getByRole('button', { name: 'Other' }));
  await waitFor(() => expect(window.location.hash).toBe('#/c/two'));
  expect(screen.getByText('reply in two')).toBeTruthy();
  window.history.replaceState(null, '', '/');
});

it('opens the conversation the address names and returns to cached conversations at once', async () => {
  localStorage.setItem('mob-token', 'current');
  window.history.replaceState(null, '', '/#/c/two');
  let hold = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'First' }, { id: 'two', title: 'Second' }]);
    const id = url.match(/\/conversations\/(\w+)$/)?.[1];
    if (id === 'two' && hold) return new Promise<Response>(() => {});
    if (id) { return Response.json({ messages: [{ id: `m-${id}`, role: 'assistant', parts: [{ type: 'text', text: `reply in ${id}` }] }], active: false, model: 'demo/echo' }); }
    return Response.json({});
  }));
  render(<App />);
  await screen.findByText('reply in two');
  expect(window.location.hash).toBe('#/c/two');
  screen.getByRole('button', { name: 'First' }).click();
  await screen.findByText('reply in one');
  expect(window.location.hash).toBe('#/c/one');
  // The cached conversation shows although its refresh never returns.
  hold = true;
  window.history.back();
  await screen.findByText('reply in two');
  expect(window.location.hash).toBe('#/c/two');
});

it('keeps the newest back or forward choice when an earlier one answers later', async () => {
  localStorage.setItem('mob-token', 'current');
  window.history.replaceState(null, '', '/#/c/three');
  let releaseTwo!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'First' }, { id: 'two', title: 'Second' }, { id: 'three', title: 'Third' }]);
    const id = url.match(/\/conversations\/(\w+)$/)?.[1];
    const snapshot = () => Response.json({ messages: [{ id: `m-${id}`, role: 'assistant', parts: [{ type: 'text', text: `reply in ${id}` }] }], active: false, model: 'demo/echo' });
    if (id === 'two') return new Promise<Response>(resolve => { releaseTwo = () => resolve(snapshot()); });
    if (id) return snapshot();
    return Response.json({});
  }));
  render(<App />);
  await screen.findByText('reply in three');
  const go = (id: string) => { window.history.replaceState(null, '', `/#/c/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); };
  go('two');
  await waitFor(() => expect(releaseTwo).toBeDefined());
  go('one');
  await screen.findByText('reply in one');
  releaseTwo();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(window.location.hash).toBe('#/c/one');
  expect(screen.queryByText('reply in two')).toBeNull();
  expect(screen.getByText('reply in one')).toBeTruthy();
});

it('opens the page the address names, with its conversation behind it, and goes back to the conversation', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  window.history.replaceState(null, '', '/#/usage');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    if (url.includes('/usage')) return Response.json({ totalTokens: 0, models: [], days: [], top: [] });
    if (url.includes('/tasks')) return Response.json([]);
    return Response.json({ messages: [{ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'kept reply' }] }], active: false, model: 'demo/echo' });
  }));
  render(<App />);
  await screen.findByRole('heading', { name: 'Token usage' });
  expect(window.location.hash).toBe('#/usage');
  expect(screen.getAllByRole('button', { name: 'Token usage' })[0].getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getAllByRole('button', { name: 'Agents' })[0]);
  await screen.findByRole('heading', { name: 'Agents' });
  expect(window.location.hash).toBe('#/agents');
  fireEvent.click(screen.getByRole('button', { name: 'Existing' }));
  await waitFor(() => expect(window.location.hash).toBe('#/c/one'));
  expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull();
  expect(screen.getByText('kept reply')).toBeTruthy();
  window.history.replaceState(null, '', '/');
});

it('uses the shared highlighter for message text, reasoning and tool data', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Code' }]);
    return Response.json({ model: 'demo/echo', active: false, messages: [{
      id: 'reply', role: 'assistant', parts: [
        { type: 'text', text: '```typescript\nconst answer = 42;\n```' },
        { type: 'reasoning', text: '**Checking**\n\n```python\nprint(42)\n```' },
        { type: 'dynamic-tool', toolName: 'example', toolCallId: 'call', state: 'output-available', input: { query: 'answer' }, output: { answer: 42 } },
      ],
    }] });
  }));
  const view = render(<App />);
  await screen.findByLabelText('Message');
  await waitFor(() => {
    for (const selector of ['.assistant-content', '.reasoning', '.tool-body']) {
      expect(view.container.querySelector(`${selector} code span[style*="--shiki-dark"]`)).toBeTruthy();
    }
    expect(view.container.querySelectorAll('.tool-body [data-streamdown="code-block"]')).toHaveLength(2);
  });
  expect(view.container.querySelector('.reasoning [data-streamdown="strong"]')?.textContent).toBe('Checking');
});

it('keeps the empty Agents page the address names, and starts a conversation from an example', async () => {
  window.mobDesktop = { connection: async () => ({ url: 'http://localhost', token: 'token' }) };
  window.history.replaceState(null, '', '/#/agents');
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([]);
    if (url.includes('/tasks')) return Response.json([]);
    return Response.json({ messages: [], active: false, model: '' });
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('heading', { name: 'No agents yet' });
  expect(window.location.hash).toBe('#/agents');
  fireEvent.click(screen.getByRole('button', { name: /Have Claude Agent review/ }));
  await waitFor(() => expect(window.location.hash).toMatch(/^#\/c\/[0-9a-f]{32}$/));
  await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Have Claude Agent review the last commit in my project'));
  // Nothing is sent until the owner sends it.
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  window.history.replaceState(null, '', '/');
});
