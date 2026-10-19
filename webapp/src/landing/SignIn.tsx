import { useCallback, useEffect, useRef, useState } from 'react';
import { appURL, authClient, type Site } from './auth';
import { Turnstile, type TurnstileHandle } from './Turnstile';
import { PixelIcon } from './PixelIcon';

function GitHubMark() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

// GitHub is the only way in. Turnstile has to pass before the GitHub flow starts.
export function SignIn({ site, siteError, reason, onClose }: {
	site?: Site;
	siteError?: string;
	reason?: string;
	onClose: () => void;
}) {
	const [token, setToken] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const turnstile = useRef<TurnstileHandle>(null);
	const close = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
		window.addEventListener('keydown', escape);
		close.current?.focus();
		return () => window.removeEventListener('keydown', escape);
	}, [onClose]);

	const onToken = useCallback((next: string) => setToken(next), []);
	const onError = useCallback((message: string) => setError(message), []);

	async function github() {
		if (!token) { setError('Finish the human check first.'); return; }
		setBusy(true); setError('');
		const result = await authClient.signIn.social(
			{ provider: 'github', callbackURL: appURL(), errorCallbackURL: '/?signin=failed' },
			{ headers: { 'x-captcha-response': token } },
		);
		if (result.error) {
			setError(result.error.message || 'GitHub sign-in did not start. Try again.');
			turnstile.current?.reset();
			setBusy(false);
		}
	}

	const ready = site?.ready && site.turnstileSiteKey;
	return (
		<div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
			<div className="dialog" role="dialog" aria-modal="true" aria-labelledby="sign-in-title">
				<span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
				<button className="dialog-close" onClick={onClose} aria-label="Close" ref={close}>×</button>
				<PixelIcon name="lock" size={28} className="dialog-icon" />
				<h2 id="sign-in-title">Sign in to Mob</h2>
				<p className="dialog-lede">{reason ?? 'Use your GitHub account to open Mob on the web. Your conversations stay on your computer.'}</p>
				{siteError ? <p className="form-error" role="alert">{siteError}</p> : null}
				{site && !ready ? <p className="form-error" role="alert">Sign-in is not set up on this site yet.</p> : null}
				{ready ? (
					<div className="auth-form">
						<Turnstile ref={turnstile} siteKey={site.turnstileSiteKey} action="github" onToken={onToken} onError={onError} />
						{error ? <p className="form-error" role="alert">{error}</p> : null}
						<button type="button" className="btn primary wide" onClick={github} disabled={busy || !token}>
							<GitHubMark />{busy ? 'Opening GitHub…' : 'Continue with GitHub'}
						</button>
						<p className="fine-print">Mob asks GitHub only for your name, email and avatar.</p>
					</div>
				) : !site && !siteError ? <p className="dialog-lede">Loading…</p> : null}
			</div>
		</div>
	);
}
