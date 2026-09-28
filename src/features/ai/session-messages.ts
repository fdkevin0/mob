/** Session UI messages preserve text and native file parts for model input. */
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import type { SessionMessage } from 'agents/sessions';

function textMessage(role: 'user' | 'assistant', text: string, id: string): SessionMessage {
	return { id, role, parts: [{ type: 'text', text }] };
}

/** Build the user UIMessage for a turn (`id` defaults to a generated one). */
export function userMessage(text: string, id: string = crypto.randomUUID()): SessionMessage {
	return textMessage('user', text, id);
}

/** Build the assistant UIMessage for a turn's final text. */
export function assistantMessage(text: string, id: string = crypto.randomUUID()): SessionMessage {
	return textMessage('assistant', text, id);
}

/** Convert Session history to model input; the system prompt is supplied separately. */
export async function historyToModelMessages(history: SessionMessage[]): Promise<ModelMessage[]> {
	return convertToModelMessages(history as unknown as UIMessage[]);
}
