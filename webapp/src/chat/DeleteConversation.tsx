import { useState } from 'react';
import type { Connection, Conversation } from './api';
import { Button } from '../components/ui/button';
import { DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { Notice } from '../components/ui/notice';

/** DeleteConversation asks before a conversation and what was said in it are deleted, since that cannot be undone. */
export function DeleteConversation({
	connection,
	conversation,
	confirm,
	cancel,
}: {
	connection: Connection;
	conversation: Conversation;
	confirm: () => Promise<void>;
	cancel: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState('');
	const where = connection.browser ? 'this browser' : connection.runner ? 'your runner' : 'this computer';
	return (
		<DialogContent className="connect-dialog delete-dialog">
			<DialogTitle className="dialog-title">Delete this conversation?</DialogTitle>
			<DialogDescription className="dialog-description">
				“{conversation.title}” and its messages are deleted from {where}, and cannot be brought back. Memories you approved in it stay.
			</DialogDescription>
			{failure && <Notice tone="error">{failure}</Notice>}
			<div className="browser-limits-actions">
				<Button
					className="danger"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						setFailure('');
						confirm().catch((e) => {
							setFailure(e instanceof Error ? e.message : String(e));
							setBusy(false);
						});
					}}
				>
					{busy ? 'Deleting…' : 'Delete'}
				</Button>
				<Button variant="ghost" onClick={cancel}>
					Cancel
				</Button>
			</div>
		</DialogContent>
	);
}
