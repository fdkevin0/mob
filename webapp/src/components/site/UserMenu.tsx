import { useState, type MouseEventHandler } from 'react';
import { authClient } from '../../landing/auth';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../ui/dropdown-menu';

export function UserMenu({ onSignIn }: { onSignIn?: MouseEventHandler<HTMLButtonElement> }) {
	const session = authClient.useSession();
	const user = session.data?.user;
	const [failedImage, setFailedImage] = useState<string>();
	const [error, setError] = useState('');
	const [signingOut, setSigningOut] = useState(false);

	async function signOut() {
		setSigningOut(true);
		setError('');
		try {
			const result = await authClient.signOut();
			if (result.error) setError('Could not sign out. Try again.');
		} catch {
			setError('Could not sign out. Try again.');
		} finally {
			setSigningOut(false);
		}
	}

	if (!user) return <button type="button" className="site-user site-login" aria-label={session.isPending ? 'Loading account' : 'Log in'} title={session.isPending ? 'Loading account' : 'Log in'} disabled={session.isPending} aria-haspopup={onSignIn ? 'dialog' : undefined}
		onClick={onSignIn ?? (() => window.location.assign('/?signin=account'))}>Log in</button>;

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild><button type="button" className="site-user" aria-label="Account" title={user.name || user.email}>
				{user.image && user.image !== failedImage ? <img src={user.image} alt="" onError={() => setFailedImage(user.image!)} /> : (user.name || user.email).slice(0, 1).toUpperCase()}
			</button></DropdownMenuTrigger>
			<DropdownMenuContent className="site-user-menu">
				<DropdownMenuLabel className="ui-menu-label"><strong>{user.name}</strong>{user.email}</DropdownMenuLabel>
				<DropdownMenuItem className="ui-menu-item" asChild><a href="/account">Account</a></DropdownMenuItem>
				<DropdownMenuItem className="ui-menu-item" disabled={signingOut} onSelect={event => { event.preventDefault(); void signOut(); }}>{signingOut ? 'Signing out…' : 'Sign out'}</DropdownMenuItem>
				{error ? <p role="alert" className="ui-menu-label">{error}</p> : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
