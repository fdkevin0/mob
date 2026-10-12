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

// isPublicWeb tells the build deployed to Cloudflare Workers (vite --mode public)
// from the page Mob serves itself. It has no API of its own, so it talks to the
// Mob address a mob open --web link gave it.
export function isPublicWeb() {
  return import.meta.env.MODE === 'public';
}

export type Offer = { url: string; code: string };
// readOffer decodes the base64url JSON offer in a mob open --web link. Only
// Mob on this computer is accepted, so a crafted link cannot send what you
// type to another server.
export function readOffer(encoded: string): Offer {
  let offer: { v?: unknown; url?: unknown; code?: unknown };
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    offer = JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new Error('This sign-in link is damaged. Run mob open --web again.'); }
  if (offer?.v !== 1 || typeof offer.url !== 'string' || typeof offer.code !== 'string' || !offer.code) throw new Error('This page does not understand the sign-in link. Run mob open --web again.');
  let url: URL;
  try { url = new URL(offer.url); } catch { throw new Error('This sign-in link is damaged. Run mob open --web again.'); }
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || url.origin !== offer.url) throw new Error('This sign-in link points to another computer, so it was ignored.');
  return { url: offer.url, code: offer.code };
}

// timeoutFor bounds a request in milliseconds. Plugin routes and command
// execution reach remote services that the service itself allows up to 45 seconds.
export function timeoutFor(path: string) {
  return path.startsWith('/plugins') || path === '/commands/run' ? 60_000 : 10_000;
}

// A 401 means the token was replaced, such as by mob token rotate. The event names
// the rejected token so a late response for an older token cannot sign out a newer one.
export const unauthorizedEvent = 'mob:unauthorized';
export const authorizedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) {
    const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? '';
    window.dispatchEvent(new CustomEvent<string>(unauthorizedEvent, { detail: token }));
  }
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
