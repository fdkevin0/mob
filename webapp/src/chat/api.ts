import type { UIMessage } from 'ai';

export type Connection = { url: string; token: string };
export type Conversation = { id: string; title: string; updatedAt: number };
export type ChatMessage = UIMessage<{ status?: string; error?: string; model?: string; command?: boolean }>;
// model is the reference the conversation's next turn uses; /model changes it.
export type Snapshot = { messages: ChatMessage[]; active: boolean; model: string };
export type { Config } from './contracts';

declare global {
  interface Window { go?: { main?: { Desktop?: { Connection: () => Promise<Connection> } } } }
}

export function defaultURL() {
  return import.meta.env.DEV ? 'http://127.0.0.1:8787' : window.location.origin;
}

// timeoutFor bounds a request in milliseconds. Plugin routes and command
// execution reach remote services that the service itself allows up to 45 seconds.
export function timeoutFor(path: string) {
  return path.startsWith('/plugins') || path === '/commands/run' ? 60_000 : 10_000;
}

// A 401 means the token was replaced, such as by mob token rotate; the app then signs out.
export const unauthorizedEvent = 'mob:unauthorized';
export const authorizedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) window.dispatchEvent(new Event(unauthorizedEvent));
  return response;
};

export async function api<T>(connection: Connection, path: string, body?: object): Promise<T> {
  const response = await authorizedFetch(`${connection.url}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutFor(path)),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  return response.json();
}
