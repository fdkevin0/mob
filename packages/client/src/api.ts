import type { UIMessage } from 'ai';
import { hc, type ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { AppType, llm, Stats } from '@mob/core';
import type { Transfer } from './contracts';

export type Connection = { url: string; token: string };
export type Conversation = {
	id: string;
	title: string;
	updatedAt: number;
	/** active is set while Mob replies in the conversation. */
	active?: boolean;
	/** waiting is set while a tool call in it awaits the owner's decision. */
	waiting?: boolean;
};
/** ReplyUsage is what a reply's model requests used; outputTokens includes reasoning. */
export type ReplyUsage = llm.Usage;
/** ReplyStats is how long a reply took; timedOutput / generationMs is how fast its model wrote. */
export type ReplyStats = Stats;
export type ChatMessage = UIMessage<{ status?: string; error?: string; model?: string; command?: boolean; usage?: ReplyUsage; stats?: ReplyStats }>;
export type Snapshot = { messages: ChatMessage[]; active: boolean; model: string };
export type ClientType = 'web' | 'tui';

// Plugin operations and commands can take as long as the service's remote calls.
export function timeoutFor(path: string) {
	return path.startsWith('/plugins') || path === '/commands/run' || path.endsWith('/export') || path.endsWith('/import') ? 60_000 : 10_000;
}

/** Fetch is the part of fetch the client calls. */
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Answer is what a successful response of an RPC call carries. */
export type Answer<R> = R extends ClientResponse<infer T, infer S, infer F> ? (S extends SuccessStatusCode ? (F extends 'json' ? T : never) : never) : never;

/** ok is an RPC call's successful answer; any other status throws with the service's message. */
export async function ok<R extends ClientResponse<unknown, number, string>>(call: Promise<R>): Promise<Answer<R>> {
	const response = await call;
	if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
	return response.json() as Promise<Answer<R>>;
}

/** rpc is a typed client of a Mob's API: paths, bodies and answers come from the service's routes. */
export function rpc(connection: Connection, fetcher: Fetch) {
	return hc<AppType>(connection.url, {
		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			// The browser runner's connection has no URL, so paths may be relative.
			const path = new URL(input instanceof Request ? input.url : input, 'http://localhost').pathname.replace(/^\/api/, '');
			return fetcher(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutFor(path)) });
		}) as typeof fetch,
		headers: () => ({ Authorization: `Bearer ${connection.token}` }),
	}).api;
}

export type Rpc = ReturnType<typeof rpc>;

export class MobClient {
	readonly fetch: Fetch;
	/** api calls the service's routes, typed by them. */
	readonly api: Rpc;

	constructor(
		readonly connection: Connection,
		options: { fetch?: Fetch; onUnauthorized?: (token: string) => void } = {},
	) {
		this.fetch = async (input, init) => {
			const response = await (options.fetch ?? globalThis.fetch)(input, init);
			if (response.status === 401) options.onUnauthorized?.(connection.token);
			return response;
		};
		this.api = rpc(connection, this.fetch);
	}

	async request<T>(path: string, body?: object): Promise<T> {
		const response = await this.fetch(`${this.connection.url}/api${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { Authorization: `Bearer ${this.connection.token}`, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutFor(path)),
		});
		if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
		return response.json();
	}

	listConversations() {
		return ok(this.api.conversations.$get());
	}
	createConversation() {
		return ok(this.api.conversations.$post());
	}
	openConversation(id: string) {
		return ok(this.api.conversations[':id'].$get({ param: { id } })) as Promise<Snapshot>;
	}
	/** renameConversation gives a conversation the owner's title; deleteConversation deletes it and what was said in it. */
	renameConversation(id: string, title: string) {
		return ok(this.api.conversations[':id'].rename.$post({ param: { id }, json: { title } }));
	}
	/** setModel makes a conversation's later replies use model, or the default when it is empty; it adds nothing to the transcript. */
	setModel(id: string, model: string) {
		return ok(this.api.conversations[':id'].model.$post({ param: { id }, json: { model } }));
	}
	deleteConversation(id: string) {
		return ok(this.api.conversations[':id'].delete.$post({ param: { id } }));
	}
	/** exportConversation and importConversation copy a conversation from one Mob to another. */
	async exportConversation(id: string) {
		return ok(this.api.conversations[':id'].export.$get({ param: { id } })) as Promise<Transfer>;
	}
	importConversation(t: Transfer) {
		return ok(this.api.conversations.import.$post({ json: t }));
	}
	complete(id: string, text: string, clientType: ClientType) {
		return ok(this.api.commands.complete.$post({ json: { client: clientType, conversationId: id, text } }));
	}
}

// Suggestions replace the final whitespace-separated token, in either UI.
export function lastToken(text: string): [string, string] {
	const i = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t')) + 1;
	return [text.slice(0, i), text.slice(i)];
}
