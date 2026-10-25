import { ConversationClient, type Changes } from '@mob/client';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type FormEvent } from 'react';
import { webClient, type Connection, type Snapshot } from './api';
import type { Action } from './contracts';

export function useConversation({
	connection,
	id,
	initial,
	initialInput = '',
	onChanged,
	onAction,
	onLeave,
	changes,
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	initialInput?: string;
	onChanged: () => void;
	onAction?: (action: Action) => void;
	/** onLeave receives what the conversation showed when it closes or the page is hidden, so reopening it can show that at once. */
	onLeave?: (snapshot: Snapshot, input: string) => void;
	changes?: Changes;
}) {
	const callbacks = useRef({ onChanged, onAction, onLeave });
	callbacks.current = { onChanged, onAction, onLeave };
	const conversation = useMemo(
		() => {
			const client = new ConversationClient({
				client: webClient(connection),
				id,
				initial,
				clientType: 'web',
				// About 20 renders a second keeps streaming smooth without re-rendering on every token.
				throttleMs: 50,
				changes,
				onChanged: () => callbacks.current.onChanged(),
				onAction: (action) => callbacks.current.onAction?.(action),
			});
			client.setInput(initialInput);
			return client;
		},
		[connection, id, changes],
	);
	const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
	useEffect(() => {
		const stop = conversation.start();
		const leave = () => {
			const { messages, model, remoteBusy, input } = conversation.getSnapshot();
			callbacks.current.onLeave?.({ messages, model, active: remoteBusy }, input);
		};
		// A page being hidden may be closing, so what it shows is handed over then too.
		const hidden = () => {
			if (document.hidden) leave();
		};
		document.addEventListener('visibilitychange', hidden);
		return () => {
			document.removeEventListener('visibilitychange', hidden);
			stop();
			leave();
		};
	}, [conversation]);
	const run = useCallback(
		(text: string) => {
			if (conversation.getSnapshot().busy) return false;
			void conversation.submit(text, { preserveInput: true });
			return true;
		},
		[conversation],
	);
	return {
		...state,
		setInput: conversation.setInput,
		run,
		submit: (event: FormEvent) => {
			event.preventDefault();
			void conversation.submit();
		},
		proceed: conversation.proceed,
		resend: conversation.resend,
		decide: conversation.decide,
		cancel: conversation.cancel,
		dismissCommand: conversation.dismissCommand,
	};
}
