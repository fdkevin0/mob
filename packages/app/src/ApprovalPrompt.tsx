import { useState } from 'react';
import { Button } from '@mob/ui/button';
import { Input } from '@mob/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@mob/ui/dropdown-menu';

/**
 * ApprovalPrompt asks the user to decide a tool request. An approval may be remembered for this conversation or always,
 * so calls like it stop asking; a denial may say why, and Mob answers it.
 */
export function ApprovalPrompt({
	question,
	request,
	whole = true,
	busy,
	allow = 'Allow once',
	decide,
}: {
	question: string;
	/** allow names approving once, such as with the changes the owner made. */
	allow?: string;
	/** request is the request's details; unset when the card shows them itself. */
	request?: string;
	whole?: boolean;
	busy: boolean;
	decide: (approved: boolean, reason?: string, remember?: 'conversation' | 'always') => void;
}) {
	const [denying, setDenying] = useState(false);
	const [reason, setReason] = useState('');
	return (
		<div className="approval-prompt" aria-busy={busy}>
			<p className="approval-question">{question}</p>
			{request !== undefined && (
				<details className="approval-request" open>
					<summary>{whole ? 'Request details' : 'Partial request'}</summary>
					<pre tabIndex={0}>{request || 'No input parameters.'}</pre>
				</details>
			)}
			{!whole && <p className="approval-note">Too long to show here; open its conversation to approve it.</p>}
			{denying ? (
				<form
					className="approval-actions"
					onSubmit={(e) => {
						e.preventDefault();
						if (!busy) decide(false, reason.trim() || undefined);
					}}
				>
					<Input
						aria-label="Reason for denying (optional)"
						placeholder="Tell Mob why (optional)"
						value={reason}
						maxLength={2000}
						autoFocus
						disabled={busy}
						onChange={(e) => setReason(e.target.value)}
					/>
					<Button disabled={busy}>Deny</Button>
					<Button type="button" variant="ghost" disabled={busy} onClick={() => setDenying(false)}>
						Back
					</Button>
				</form>
			) : (
				<div className="approval-actions">
					{whole && <Button type="button" disabled={busy} onClick={() => decide(true)}>{allow}</Button>}
					<Button type="button" variant="outline" disabled={busy} onClick={() => setDenying(true)}>Deny…</Button>
					{whole && <DropdownMenu>
						<DropdownMenuTrigger asChild><Button type="button" variant="ghost" disabled={busy}>More permissions…</Button></DropdownMenuTrigger>
						<DropdownMenuContent className="approval-menu" align="start" onClick={event => event.stopPropagation()}>
							<DropdownMenuLabel className="ui-menu-label">Allow now and remember</DropdownMenuLabel>
							<DropdownMenuItem className="ui-menu-item" disabled={busy} onSelect={() => decide(true, undefined, 'conversation')}>Allow in this conversation</DropdownMenuItem>
							<DropdownMenuItem className="ui-menu-item" disabled={busy} onSelect={() => decide(true, undefined, 'always')}>Always allow across conversations</DropdownMenuItem>
							<p className="approval-menu-note">Future calls covered by this tool’s permission scope will run without asking. This may cover different inputs. Review with /grants; revoke with /revoke.</p>
						</DropdownMenuContent>
					</DropdownMenu>}
				</div>
			)}
			{busy && <p className="approval-note" role="status">Submitting decision…</p>}
		</div>
	);
}
