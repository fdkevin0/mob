// The page and the browser runner's worker exchange these messages. A request
// is a Fetch API request in parts; its response comes back as a head, then
// body chunks as the server writes them, then an end or an error.
export type ToWorker =
	| { type: 'init'; token: string }
	| { type: 'request'; id: number; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
	| { type: 'abort'; id: number };

export type FromWorker =
	| { type: 'ready'; persistent: boolean }
	| { type: 'failed'; error: string }
	| { type: 'head'; id: number; status: number; headers: [string, string][] }
	| { type: 'chunk'; id: number; chunk: Uint8Array }
	| { type: 'end'; id: number }
	| { type: 'error'; id: number; error: string };
