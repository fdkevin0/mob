import { useEffect, useState, type KeyboardEvent } from 'react';
import { lastToken } from '@mob/client';
import { webClient, type Connection } from './api';
import type { Suggestion } from './contracts';

export { lastToken };

// useCompletion suggests slash commands and their arguments from the service.
export function useCompletion({
	connection,
	id,
	input,
	setInput,
}: {
	connection: Connection;
	id: string;
	input: string;
	setInput: (text: string) => void;
}) {
	// Suggestions stay visible while a newer answer is on its way but apply only
	// to the text they were computed for.
	const [{ suggestions, source }, setShown] = useState<{ suggestions: Suggestion[]; source?: string }>({ suggestions: [] });
	const setSuggestions = (list: Suggestion[], text?: string) => setShown({ suggestions: list, source: text });
	const [selected, setSelected] = useState(0);
	const [dismissed, setDismissed] = useState<string>();
	useEffect(() => {
		if (!input.startsWith('/') || /[\r\n]/.test(input) || input === dismissed) {
			setSuggestions([]);
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			// Completion is a convenience; a failure only leaves the list empty.
			webClient(connection)
				.complete(id, input, 'web')
				.then(
					(list) => {
						if (live) {
							setSuggestions(list, input);
							setSelected(0);
						}
					},
					() => {
						if (live) setSuggestions([]);
					},
				);
		}, 120);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [connection, id, input, dismissed]);
	useEffect(() => {
		document.getElementById(`suggestion-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
	}, [selected, suggestions]);
	function accept(index: number) {
		const [head] = lastToken(input);
		setInput(head + suggestions[index].value + ' ');
		setSuggestions([]);
	}
	// onKeyDown reports whether it handled the key. Enter accepts only a
	// suggestion that changes a partly typed token, so a complete command sends;
	// neither Tab nor Enter applies suggestions made for older text.
	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (!suggestions.length || event.nativeEvent.isComposing) return false;
		if (event.key === 'ArrowDown') setSelected((selected + 1) % suggestions.length);
		else if (event.key === 'ArrowUp') setSelected((selected + suggestions.length - 1) % suggestions.length);
		else if (event.key === 'Escape') {
			setDismissed(input);
			setSuggestions([]);
		} else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
			const [, token] = lastToken(input);
			const stale = input !== source;
			if (event.key === 'Enter' && (stale || token === '' || token === suggestions[selected].value)) return false;
			if (!stale) accept(selected);
		} else return false;
		event.preventDefault();
		return true;
	}
	return { suggestions, selected, accept, onKeyDown };
}
