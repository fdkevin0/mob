import type { UIMessage } from 'ai';
import type { Suggestion, Transfer } from './contracts';

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
export type ChatMessage = UIMessage<{ status?: string; error?: string; model?: string; command?: boolean }>;
export type Snapshot = { messages: ChatMessage[]; active: boolean; model: string };
export type ClientType = 'web' | 'tui';

// Plugin operations and commands can take as long as the service's remote calls.
export function timeoutFor(path: string) {
	return path.startsWith('/plugins') || path === '/commands/run' || path.endsWith('/export') || path.endsWith('/import') ? 60_000 : 10_000;
}

/** Fetch is the part of fetch the client calls. */
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MobClient {
	readonly fetch: Fetch;

	constructor(
		readonly connection: Connection,
		options: { fetch?: Fetch; onUnauthorized?: (token: string) => void } = {},
	) {
		this.fetch = async (input, init) => {
			const response = await (options.fetch ?? globalThis.fetch)(input, init);
			if (response.status === 401) options.onUnauthorized?.(connection.token);
			return response;
		};
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
		return this.request<Conversation[]>('/conversations');
	}
	createConversation() {
		return this.request<Conversation>('/conversations', {});
	}
	openConversation(id: string) {
		return this.request<Snapshot>(`/conversations/${id}`);
	}
	/** renameConversation gives a conversation the owner's title; deleteConversation deletes it and what was said in it. */
	renameConversation(id: string, title: string) {
		return this.request<{ id: string; title: string }>(`/conversations/${id}/rename`, { title });
	}
	/** setModel makes a conversation's later replies use model, or the default when it is empty; it adds nothing to the transcript. */
	setModel(id: string, model: string) {
		return this.request<{ model: string }>(`/conversations/${id}/model`, { model });
	}
	deleteConversation(id: string) {
		return this.request<{ deleted: boolean }>(`/conversations/${id}/delete`, {});
	}
	/** exportConversation and importConversation copy a conversation from one Mob to another. */
	async exportConversation(id: string) {
		return this.request<Transfer>(`/conversations/${id}/export`);
	}
	importConversation(t: Transfer) {
		return this.request<Conversation>('/conversations/import', t);
	}
	complete(id: string, text: string, clientType: ClientType) {
		return this.request<Suggestion[]>('/commands/complete', { client: clientType, conversationId: id, text });
	}
}

// Suggestions replace the final whitespace-separated token, in either UI.
export function lastToken(text: string): [string, string] {
	const i = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t')) + 1;
	return [text.slice(0, i), text.slice(i)];
}
