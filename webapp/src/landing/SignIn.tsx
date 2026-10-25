import { useCallback, useRef, useState, type RefObject } from 'react';
import { authClient, errorCode, openApp, signedInURL, type Site } from './auth';
import { Turnstile, type TurnstileHandle } from './Turnstile';
import { Icon } from '../components/brand/Icon';
import { DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { Button } from '../components/ui/button';

function GitHubMark() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

function CloudflareMark() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
			<path d="M11.2 10.6l.2-.7c.2-.8.1-1.5-.3-2-.4-.5-1-.7-1.7-.8L3.4 7c-.1 0-.1 0-.2-.1v-.1c0-.1.1-.1.2-.2l5.8-.1c.7 0 1.4-.6 1.7-1.3l.4-1c0-.1 0-.1 0-.2A3.8 3.8 0 003.9 4a2.3 2.3 0 00-3.4 2.1c0 .1 0 .3 0 .4A2.6 2.6 0 000 8.8c0 .7.1 1.4.2 1.9 0 .1.1.1.1.1h10.6c.1 0 .2 0 .3-.2zM13 6.9h-.3c-.1 0-.1 0-.1.1l-.2.8c-.2.8-.1 1.5.3 2 .4.5 1 .7 1.7.8l1.2.1c.1 0 .1 0 .1.1v.1c0 .1-.1.1-.2.2l-1.3.1c-.7 0-1.4.6-1.7 1.3l-.1.3c0 .1 0 .1.1.1h4.4c.1 0 .1 0 .1-.1A3 3 0 0013 6.9z" />
		</svg>
	);
}

const passkeys = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window;

// GitHub creates the account, and Turnstile has to pass before its flow starts.
// A passkey bound on the account page signs in to that same account.
export function SignIn({ site, siteError, reason, returnFocus }: {
	site?: Site;
	siteError?: string;
	reason?: string;
	returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
	const [token, setToken] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState<'github' | 'cloudflare' | 'passkey'>();
	const turnstile = useRef<TurnstileHandle>(null);

	const onToken = useCallback((next: string) => setToken(next), []);
	const onError = useCallback((message: string) => setError(message), []);

	async function social(provider: 'github' | 'cloudflare') {
		if (!token) { setError('Finish the human check first.'); return; }
		setBusy(provider); setError('');
		const name = provider === 'github' ? 'GitHub' : 'Cloudflare';
		let message: string | undefined;
		try {
			const result = await authClient.signIn.social(
				{ provider, callbackURL: signedInURL, errorCallbackURL: '/?signin=failed' },
				{ headers: { 'x-captcha-response': token } },
			);
			if (result.error) message = result.error.message || `${name} sign-in did not start. Try again.`;
		} catch {
			message = 'Could not reach the sign-in service. Check your connection and try again.';
		}
		if (message === undefined) return;
		setError(message);
		turnstile.current?.reset();
		setBusy(undefined);
	}

	async function passkey() {
		setBusy('passkey'); setError('');
		let message: string;
		try {
			const result = await authClient.signIn.passkey();
			if (!result.error) { openApp(); return; }
			const code = errorCode(result.error);
			message = code === 'PASSKEY_NOT_FOUND'
				? 'This passkey is not added to a Mob account. Continue with GitHub, then add it on your account page.'
				: code === 'AUTH_CANCELLED' || code?.startsWith('ERROR_')
					? 'Passkey sign-in was cancelled.'
					: result.error.message || 'That passkey did not sign in. Try again, or continue with GitHub.';
		} catch {
			message = 'Could not reach the sign-in service. Check your connection and try again.';
		}
		setError(message);
		setBusy(undefined);
	}

	const ready = site?.ready && site.turnstileSiteKey;
	return (
		<DialogContent className="sign-in-dialog" onCloseAutoFocus={event => {
			if (returnFocus?.current) { event.preventDefault(); returnFocus.current.focus(); }
		}}>
			<Icon name="lock" size={28} className="dialog-icon" />
			<DialogTitle className="dialog-title">Sign in to Mob</DialogTitle>
			<DialogDescription className="dialog-description">{reason ?? `Use your GitHub${site?.cloudflare ? ' or Cloudflare' : ''} account to open Mob on the web. Your conversations stay on your computer.`}</DialogDescription>
			{siteError ? <p className="form-error" role="alert">{siteError}</p> : null}
			{site && !ready ? <p className="form-error" role="alert">Sign-in is not set up on this site yet.</p> : null}
			{ready ? (
				<div className="auth-form">
					<Turnstile ref={turnstile} siteKey={site.turnstileSiteKey} action="github" onToken={onToken} onError={onError} />
					{error ? <p className="form-error" role="alert">{error}</p> : null}
					<Button type="button" className="wide" onClick={() => void social('github')} disabled={!!busy || !token}>
						<GitHubMark />{busy === 'github' ? 'Opening GitHub…' : 'Continue with GitHub'}
					</Button>
					{site.cloudflare ? (
						<Button type="button" variant="outline" className="wide" onClick={() => void social('cloudflare')} disabled={!!busy || !token}>
							<CloudflareMark />{busy === 'cloudflare' ? 'Opening Cloudflare…' : 'Continue with Cloudflare'}
						</Button>
					) : null}
					{passkeys() ? (
						<Button type="button" variant="outline" className="wide" onClick={passkey} disabled={!!busy}>
							<Icon name="key" size={14} />{busy === 'passkey' ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
						</Button>
					) : null}
					<p className="fine-print">Mob asks GitHub only for your name, email and avatar.{site.cloudflare ? ' Cloudflare also lets Mob in this browser run Workers AI models on your Cloudflare account.' : ''} Add a passkey from your account page after signing in.</p>
				</div>
			) : !site && !siteError ? <p className="dialog-description">Loading…</p> : null}
		</DialogContent>
	);
}
