import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import { useConversation } from './useConversation';

const connection = { url: 'http://localhost', token: 'test' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('ignores a stale history response after a local send and restores input on failure', async () => {
  let resolveHistory!: (value: Response) => void;
  let rejectSend!: (error: Error) => void;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/chat')) return new Promise<Response>((_, reject) => { rejectSend = reject; });
    if (++reads === 1) return new Promise<Response>(resolve => { resolveHistory = resolve; });
    return Promise.resolve(Response.json({ messages: [], active: false }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => result.current.setInput('keep my text'));
  act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  await waitFor(() => expect(result.current.busy).toBe(true));
  await act(async () => resolveHistory(Response.json({ messages: [{ id: 'stale', role: 'assistant', parts: [{ type: 'text', text: 'stale history' }] }], active: false })));
  expect(result.current.messages.some(m => m.id === 'stale')).toBe(false);
  await act(async () => rejectSend(new Error('connection failed')));
  await waitFor(() => expect(result.current.input).toBe('keep my text'));
});
it('cancels an approval stream when the conversation is unmounted', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/chat')) {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }
    return Promise.resolve(Response.json({ messages: [], active: false }));
  }));
  const { result, unmount } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => { void result.current.decide('approval', true); });
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
});
it('runs slash commands through the service and sends the rest as chat', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url.endsWith('/commands/run')) {
      if (body.text === '/list') return Promise.resolve(Response.json({ handled: true, markdown: '| Conversation |' }));
      if (body.text === '/open two') return Promise.resolve(Response.json({ handled: true, action: { kind: 'open-conversation', conversationId: 'two' } }));
      if (body.text === '/approve') return Promise.resolve(Response.json({ handled: true, action: { kind: 'decide', approvalId: 'a1', approved: true } }));
      if (body.text === '/broken') return Promise.resolve(new Response('email plugin is disabled', { status: 409 }));
      return Promise.resolve(Response.json({ handled: false }));
    }
    if (url.endsWith('/chat')) { chats.push(JSON.stringify(body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const onAction = vi.fn();
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {}, onAction }));
  const submit = async (text: string) => {
    act(() => result.current.setInput(text));
    act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  };
  await submit('/list');
  await waitFor(() => expect(result.current.commandResult).toBe('| Conversation |'));
  expect(chats).toHaveLength(0);
  await submit('/open two');
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ kind: 'open-conversation', conversationId: 'two' }));
  expect(result.current.commandResult).toBeUndefined();
  await submit('/broken');
  await waitFor(() => expect(result.current.failure).toBe('email plugin is disabled'));
  expect(result.current.input).toBe('/broken');
  await submit('/approve');
  await waitFor(() => expect(chats.some(c => c.includes('"approval":{"id":"a1","approved":true}'))).toBe(true));
});
it('sends a slash command the service does not run as chat', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/commands/run')) return Promise.resolve(Response.json({ handled: false }));
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => result.current.setInput('/models'));
  act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  await waitFor(() => expect(chats.some(c => c.includes('"text":"/models"'))).toBe(true));
});
it('sends the reason a /deny gives with the denial', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/commands/run')) return Promise.resolve(Response.json({ handled: true, action: { kind: 'decide', approvalId: 'a1', approved: false, reason: 'too long' } }));
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => result.current.setInput('/deny too long'));
  act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  await waitFor(() => expect(chats.some(c => c.includes('"approval":{"id":"a1","approved":false,"reason":"too long"}'))).toBe(true));
});
it('asks the service to remember an approval', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => { void result.current.decide('a1', true, undefined, 'always'); });
  await waitFor(() => expect(chats.some(c => c.includes('"approval":{"id":"a1","approved":true,"remember":"always"}'))).toBe(true));
});
it('follows a turn that is already running, such as after a reload', async () => {
  const chunks = [{ type: 'start', messageId: 'reply' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Hello again' }, { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish', finishReason: 'stop' }];
  const streamed = chunks.map((c, i) => `id: ${i + 1}\ndata: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  let active = true;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    requests.push(`${options?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/chat/one/stream')) { active = false; return Promise.resolve(new Response(streamed, { headers: { 'Content-Type': 'text/event-stream' } })); }
    const reply = { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: active ? 'Hel' : 'Hello again' }], metadata: { status: active ? 'streaming' : 'complete' } };
    return Promise.resolve(Response.json({ messages: [{ id: 'ask', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, reply], active, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: true, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  await waitFor(() => expect(result.current.messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello again' })));
  expect(result.current.messages.map(m => m.id)).toEqual(['ask', 'reply']);
  expect(requests).toContain('GET http://localhost/api/chat/one/stream');
});
it('builds the reply afresh when a dropped stream is replayed', async () => {
  const sse = (chunks: object[]) => chunks.map((c, i) => `id: ${i + 1}\ndata: ${JSON.stringify(c)}\n\n`).join('');
  const head = [{ type: 'start', messageId: 'reply' }, { type: 'start-step' }, { type: 'text-start', id: 't' }];
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/chat/one/stream')) {
      if (++attempts === 1) {
        // The first stream drops after the first few letters.
        const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse([...head, { type: 'text-delta', id: 't', delta: 'Hel' }]))); setTimeout(() => controller.error(new TypeError('network error')), 10); } });
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return Promise.resolve(new Response(sse([...head, { type: 'text-delta', id: 't', delta: 'Hello again' }, { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' }]) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return Promise.resolve(Response.json({ messages: [{ id: 'ask', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], active: attempts < 2, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: true, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  await waitFor(() => expect(attempts).toBe(2), { timeout: 5000 });
  await waitFor(() => expect(result.current.messages.at(-1)?.parts.filter(p => p.type === 'text')).toEqual([expect.objectContaining({ text: 'Hello again' })]));
}, 10000);
it('keeps one reconnect waiting however slowly the stream answers', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/chat/one/stream')) { signals.push(options?.signal as AbortSignal); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: true, model: 'demo/echo' }));
  }));
  renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: true, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  await waitFor(() => expect(signals).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 2500));
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(false);
}, 10000);
it('waits for the next poll before following again after a failure', async () => {
  let reconnects = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/chat/one/stream')) { reconnects++; return new Promise<Response>((_, reject) => setTimeout(() => reject(new TypeError('network error')), 10)); }
    return Promise.resolve(Response.json({ messages: [], active: true, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: true, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  await waitFor(() => expect(result.current.failure).toBe('network error'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(reconnects).toBe(1);
}, 10000);
it('does not follow a turn after the conversation closes', async () => {
  let resolveSnapshot!: (value: Response) => void;
  let reconnects = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/chat/one/stream')) { reconnects++; return new Promise<Response>(() => {}); }
    return new Promise<Response>(resolve => { resolveSnapshot = resolve; });
  }));
  const { unmount } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  await waitFor(() => expect(resolveSnapshot).toBeDefined());
  unmount();
  await act(async () => resolveSnapshot(Response.json({ messages: [], active: true, model: 'demo/echo' })));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(reconnects).toBe(0);
});
