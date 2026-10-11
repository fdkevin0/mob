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

export async function api<T>(connection: Connection, path: string, body?: object): Promise<T> {
  const response = await fetch(`${connection.url}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path.startsWith('/plugins') ? 60_000 : 10_000),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  return response.json();
}
