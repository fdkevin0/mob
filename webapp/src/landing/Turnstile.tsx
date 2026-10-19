import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

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
export const Turnstile = forwardRef<TurnstileHandle, { siteKey: string; action: string; onToken: (token: string) => void; onError: (message: string) => void }>(
	function Turnstile({ siteKey, action, onToken, onError }, ref) {
		const element = useRef<HTMLDivElement>(null);
		const id = useRef<string>(undefined);
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
					theme: 'dark',
					size: 'flexible',
					callback: (token: string) => callbacks.current.onToken(token),
					'expired-callback': () => callbacks.current.onToken(''),
					'error-callback': () => { callbacks.current.onToken(''); callbacks.current.onError('The human check failed. Try again.'); },
				});
			}).catch(e => callbacks.current.onError(e instanceof Error ? e.message : String(e)));
			return () => { cancelled = true; if (id.current) window.turnstile?.remove(id.current); id.current = undefined; };
		}, [siteKey, action]);
		return <div ref={element} className="turnstile" />;
	},
);
