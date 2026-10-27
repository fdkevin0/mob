import { useCallback, useRef, useState, type RefObject } from 'react';
import { authClient, errorCode, openApp, signedInURL, type Site } from './auth';
import { Turnstile, type TurnstileHandle } from './Turnstile';
import { Icon } from '@mob/ui/brand/Icon';
import { DialogContent, DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { Button } from '@mob/ui/button';
import cloudflareIcon from '@lobehub/icons-static-svg/icons/cloudflare-color.svg?raw';
import githubIcon from '@lobehub/icons-static-svg/icons/github.svg?raw';

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
						<span className="sign-in-provider-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: githubIcon }} />{busy === 'github' ? 'Opening GitHub…' : 'Continue with GitHub'}
					</Button>
					{site.cloudflare ? (
						<Button type="button" variant="outline" className="wide" onClick={() => void social('cloudflare')} disabled={!!busy || !token}>
							<span className="sign-in-provider-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: cloudflareIcon }} />{busy === 'cloudflare' ? 'Opening Cloudflare…' : 'Continue with Cloudflare'}
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
