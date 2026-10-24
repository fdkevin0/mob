import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useScheme } from '../theme/theme';

type Widget = {
	render: (element: HTMLElement, options: Record<string, unknown>) => string;
	reset: (id: string) => void;
	remove: (id: string) => void;
};

declare global {
	interface Window { turnstile?: Widget }
}

let script: Promise<Widget> | undefined;
function loadTurnstile() {
	script ??= new Promise((resolve, reject) => {
		const tag = document.createElement('script');
		tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		tag.async = true;
		tag.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load.'));
		tag.onerror = () => { script = undefined; reject(new Error('Turnstile could not be loaded.')); };
		document.head.appendChild(tag);
	});
	return script;
}

export type TurnstileHandle = { reset: () => void };

// A token is good for one request, so the form resets the widget after each try.
// The widget lives in a cross-origin iframe: Turnstile's own 'auto' theme reads
// the system preference there, not the scheme picked on this page, and a theme
// cannot be changed after render. So it is given the page's resolved scheme and
// drawn again (with a fresh token) when that scheme changes.
export const Turnstile = forwardRef<TurnstileHandle, { siteKey: string; action: string; onToken: (token: string) => void; onError: (message: string) => void }>(
	function Turnstile({ siteKey, action, onToken, onError }, ref) {
		const element = useRef<HTMLDivElement>(null);
		const id = useRef<string>(undefined);
		const scheme = useScheme();
		const callbacks = useRef({ onToken, onError });
		callbacks.current = { onToken, onError };
		useImperativeHandle(ref, () => ({
			reset() { onToken(''); if (id.current) window.turnstile?.reset(id.current); },
		}), [onToken]);
		useEffect(() => {
			let cancelled = false;
			loadTurnstile().then(turnstile => {
				if (cancelled || !element.current) return;
				id.current = turnstile.render(element.current, {
					sitekey: siteKey,
					action,
					theme: scheme,
					size: 'flexible',
					callback: (token: string) => callbacks.current.onToken(token),
					'expired-callback': () => callbacks.current.onToken(''),
					'error-callback': () => { callbacks.current.onToken(''); callbacks.current.onError('The human check failed. Try again.'); },
				});
			}).catch(e => callbacks.current.onError(e instanceof Error ? e.message : String(e)));
			return () => {
				cancelled = true;
				if (id.current) { window.turnstile?.remove(id.current); callbacks.current.onToken(''); }
				id.current = undefined;
			};
		}, [siteKey, action, scheme]);
		return <div ref={element} className="turnstile" />;
	},
);
