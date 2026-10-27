import { useEffect, useState } from 'react';
import { browserState, type Connection } from '../api';
import { Button } from '@mob/ui/button';
import { Notice } from '@mob/ui/notice';

// What Mob in a browser tab cannot do, said once and on request: everything
// here needs a process of its own, which only a runner has.
const missing = [
	'Coding agents (Codex, Claude Agent, DeepSeek Harness, CodeBuddy) and projects',
	'The sandbox, shell commands and fetching web pages',
	'Local (stdio) MCP servers, and plugins such as Telegram, email and WeChat',
	'Schedules, and anything that runs after the last Mob tab closes',
	'Model providers that refuse browsers, such as OpenCode Zen',
];

const seenKey = 'mob-browser-limits-seen';
const seen = () => { try { return localStorage.getItem(seenKey) === '1'; } catch { return false; } };

/**
 * BrowserLimits says what the browser runner cannot do. On first use it says
 * so in a line, with the list behind "What needs a runner"; asked from the
 * sidebar, it opens with the list showing.
 */
export function BrowserLimits({ connection, open, setOpen, connect }: { connection: Connection; open: boolean; setOpen: (open: boolean) => void; connect: () => void }) {
	const [persistent, setPersistent] = useState(true);
	const [first, setFirst] = useState(false);
	useEffect(() => { if (!seen()) { setFirst(true); setOpen(true); } }, []);
	useEffect(() => {
		let live = true;
		browserState(connection).then(s => { if (live) setPersistent(s.persistent); }).catch(() => { /* the workspace reports a runner that did not start */ });
		return () => { live = false; };
	}, [connection]);
	const hide = () => { try { localStorage.setItem(seenKey, '1'); } catch { /* shown again next time */ } setFirst(false); setOpen(false); };
	if (!open && persistent) return null;
	return (
		<section className="browser-limits" aria-label="Mob in this browser">
			{!persistent && (
				<Notice tone="warning" title="Conversations are not saved in this browser." details="This browser does not let Mob keep files, as in some private windows, so conversations live in the memory of the first Mob tab you opened. Closing or reloading that tab loses them, even while other Mob tabs stay open. Connect a runner to keep them.">
					They are lost when the first Mob tab you opened closes or reloads.
				</Notice>
			)}
			{open && (
				<Notice
					tone="info"
					title="Mob is running in this browser."
					onDismiss={hide}
					detailsLabel="What needs a runner"
					detailsOpen={!first}
					details={
						<>
							<ul>{missing.map(m => <li key={m}>{m}</li>)}</ul>
							<Button variant="outline" className="small" onClick={connect}>Connect a runner</Button>
						</>
					}
				>
					Chat, approvals and memory work here, shared by every tab in this browser.
				</Notice>
			)}
		</section>
	);
}
