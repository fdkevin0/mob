// The page and the browser runner's worker exchange these messages. A request
// is a Fetch API request in parts; its response comes back as a head, then
// body chunks as the server writes them, then an end or an error.
export type ToWorker =
	| { type: 'init'; token: string }
	| { type: 'request'; id: number; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'abort'; id: number }
	// The page's answers to a prompt of Chrome's built-in model.
	| { type: 'chrome-text'; id: number; text: string }
	| { type: 'chrome-end'; id: number }
	| { type: 'chrome-error'; id: number; error: string; name?: string };

/** ChromeMessage is a turn of the conversation the worker asks the page's built-in model to answer. */
export type ChromeMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type FromWorker =
	| { type: 'ready'; persistent: boolean }
	| { type: 'failed'; error: string }
	// Whether the runner of this tab, as the leader, is running a turn, which closing the tab would stop.
	| { type: 'busy'; busy: boolean }
	| { type: 'head'; id: number; status: number; headers: [string, string][] }
	| { type: 'chunk'; id: number; chunk: Uint8Array }
	| { type: 'end'; id: number }
	| { type: 'error'; id: number; error: string }
	// Prompts of Chrome's built-in model, which only the page can call.
	| { type: 'chrome'; id: number; messages: ChromeMessage[] }
	| { type: 'chrome-abort'; id: number };

/**
 * Shared is what the runners of a browser's Mob tabs say to one another on a
 * BroadcastChannel. One tab's runner leads: it owns the database and serves
 * every tab. The others follow, passing their page's requests to the leader
 * and its answers back, until the leader's tab closes and one of them takes over.
 */
export type Shared =
	// A follower asks the leader to make itself known.
	| { type: 'hello' }
	// The leader serves; it says so when it starts and on every hello.
	| { type: 'leader'; tab: string; persistent: boolean }
	| { type: 'request'; from: string; id: number; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'abort'; from: string; id: number }
	| { type: 'head'; to: string; id: number; status: number; headers: [string, string][] }
	| { type: 'chunk'; to: string; id: number; chunk: Uint8Array }
	| { type: 'end'; to: string; id: number }
	| { type: 'error'; to: string; id: number; error: string };
