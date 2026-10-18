import { ConversationClient } from '@mob/client';
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
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	onBusy: (busy: boolean) => void;
	onChanged: () => void;
	onAction?: (action: Action) => void;
}) {
	const callbacks = useRef({ onChanged, onAction });
	callbacks.current = { onChanged, onAction };
	const conversation = useMemo(
		() =>
			new ConversationClient({
				client: webClient(connection),
				id,
				initial,
				clientType: 'web',
				onChanged: () => callbacks.current.onChanged(),
				onAction: (action) => callbacks.current.onAction?.(action),
			}),
		[connection, id],
	);
	const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
	useEffect(conversation.start, [conversation]);
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
