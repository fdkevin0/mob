// Conversation events, independent of HTTP and SSE, and their AI SDK UI chunks.
export type EventKind =
	| 'turn-started' | 'step-started' | 'segment-started' | 'segment-delta' | 'segment-finished' | 'usage'
	| 'tool-input' | 'tool-output' | 'tool-failed' | 'approval-requested' | 'step-finished'
	| 'turn-finished' | 'turn-aborted' | 'turn-failed';

export type Event = {
	kind: EventKind;
	segment?: 'text' | 'reasoning';
	messageId?: string;
	reason?: string;
	error?: string;
	id?: string;
	text?: string;
	usage?: unknown;
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
	approvalId?: string;
};

const chunkType: Record<EventKind, string> = {
	'turn-started': 'start', 'step-started': 'start-step', 'segment-started': '-start', 'segment-delta': '-delta', 'segment-finished': '-end',
	usage: 'data-usage', 'tool-input': 'tool-input-available', 'tool-output': 'tool-output-available', 'tool-failed': 'tool-output-error',
	'approval-requested': 'tool-approval-request', 'step-finished': 'finish-step', 'turn-finished': 'finish', 'turn-aborted': 'abort', 'turn-failed': 'error',
};

/** encode adapts a conversation event to the AI SDK UI wire format. */
export function encode(e: Event): Record<string, unknown> {
	const type = e.kind.startsWith('segment-') ? e.segment + chunkType[e.kind] : chunkType[e.kind];
	// The tool-input-available chunk already carried the call; the AI SDK
	// approval chunk names only the approval and the call.
	if (e.kind === 'approval-requested') return { type, toolCallId: e.toolCallId, approvalId: e.approvalId };
	const chunk: Record<string, unknown> = { type };
	const set = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== '') chunk[key] = value; };
	set('messageId', e.messageId); set('finishReason', e.reason); set('errorText', e.error); set('id', e.id); set('delta', e.text);
	if (e.usage !== undefined && e.usage !== null) chunk.data = e.usage;
	set('toolCallId', e.toolCallId); set('toolName', e.toolName);
	if (e.input !== undefined && e.input !== null) chunk.input = e.input;
	if (e.output !== undefined && e.output !== null) chunk.output = e.output;
	set('approvalId', e.approvalId);
	return chunk;
}
