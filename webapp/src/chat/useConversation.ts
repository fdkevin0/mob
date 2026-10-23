import { ConversationClient, type Changes } from '@mob/client';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type FormEvent } from 'react';
import { webClient, type Connection, type Snapshot } from './api';
import type { Action } from './contracts';

export function useConversation({
	connection,
	id,
	initial,
	onBusy,
	onChanged,
	onAction,
	onLeave,
	changes,
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	onBusy: (busy: boolean) => void;
	onChanged: () => void;
	onAction?: (action: Action) => void;
	/** onLeave receives what the conversation showed when it closes, so reopening it can show that at once. */
	onLeave?: (snapshot: Snapshot) => void;
	changes?: Changes;
}) {
	const callbacks = useRef({ onChanged, onAction, onLeave });
	callbacks.current = { onChanged, onAction, onLeave };
	const conversation = useMemo(
		() =>
			new ConversationClient({
				client: webClient(connection),
				id,
				initial,
				clientType: 'web',
				// About 20 renders a second keeps streaming smooth without re-rendering on every token.
				throttleMs: 50,
				changes,
				onChanged: () => callbacks.current.onChanged(),
				onAction: (action) => callbacks.current.onAction?.(action),
			}),
		[connection, id, changes],
	);
	const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
	useEffect(() => {
		const stop = conversation.start();
		return () => {
			stop();
			const { messages, model, remoteBusy } = conversation.getSnapshot();
			callbacks.current.onLeave?.({ messages, model, active: remoteBusy });
		};
	}, [conversation]);
	useEffect(() => {
		onBusy(state.busy);
		return () => onBusy(false);
	}, [state.busy, onBusy]);
	const run = useCallback(
		(text: string) => {
			void conversation.submit(text);
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
		decide: conversation.decide,
		cancel: conversation.cancel,
		dismissCommand: conversation.dismissCommand,
	};
}
