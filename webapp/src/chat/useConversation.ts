import { ConversationClient, type Changes } from '@mob/client';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type FormEvent } from 'react';
import { webClient, type Connection, type Snapshot } from './api';
import { cacheScope, readDraft, writeDraft } from './localCache';
import type { Action } from './contracts';

export function useConversation({
	connection,
	id,
	initial,
	initialInput,
	keeping,
	onChanged,
	onAction,
	onLeave,
	changes,
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	initialInput?: string;
	keeping?: boolean;
	onChanged: () => void;
	onAction?: (action: Action) => void;
	/** onLeave receives what the conversation showed when it closes or the page is hidden, so reopening it can show that at once. */
	onLeave?: (snapshot: Snapshot, input: string | undefined) => void;
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
			client.setInput(initialInput ?? '');
			return client;
		},
		[connection, id, changes],
	);
	// An unread draft must not be handed back as an intentional empty draft.
	const draft = useMemo(() => ({ ready: initialInput !== undefined }), [conversation]);
	const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
	useEffect(() => {
		const scope = cacheScope(connection);
		let live = true;
		let changed = false;
		let input = conversation.getSnapshot().input;
		if (input) draft.ready = true;
		const unsubscribe = conversation.subscribe(() => {
			const next = conversation.getSnapshot().input;
			if (next === input) return;
			changed = true;
			draft.ready = true;
			input = next;
			void writeDraft(scope, id, input);
		});
		if (draft.ready) void writeDraft(scope, id, input);
		else void readDraft(scope, id).then((saved) => {
			// A late read must never replace a newer edit, send, or cleared draft.
			if (!live || changed) return;
			if (saved !== undefined) conversation.setInput(saved);
			draft.ready = true;
		});
		return () => { live = false; unsubscribe(); };
	}, [conversation]);
	useEffect(() => {
		if (keeping && draft.ready) void writeDraft(cacheScope(connection), id, conversation.getSnapshot().input);
	}, [conversation, keeping]);
	useEffect(() => {
		const stop = conversation.start();
		const leave = () => {
			const { messages, model, remoteBusy, input } = conversation.getSnapshot();
			callbacks.current.onLeave?.({ messages, model, active: remoteBusy }, draft.ready ? input : undefined);
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
		decide: conversation.decide,
		cancel: conversation.cancel,
		dismissCommand: conversation.dismissCommand,
	};
}
