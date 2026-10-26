import { useEffect, useState } from 'react';
import { browserState, type Connection } from '../api';
import { Button } from '../../components/ui/button';
import { Notice } from '../../components/ui/notice';

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

/** BrowserLimits says what the browser runner cannot do; it shows on first use and whenever asked. */
export function BrowserLimits({ connection, open, setOpen, connect }: { connection: Connection; open: boolean; setOpen: (open: boolean) => void; connect: () => void }) {
	const [persistent, setPersistent] = useState(true);
	useEffect(() => { if (!seen()) setOpen(true); }, []);
	useEffect(() => {
		let live = true;
		browserState(connection).then(s => { if (live) { setPersistent(s.persistent); if (!s.persistent) setOpen(true); } }).catch(() => { /* the workspace reports a runner that did not start */ });
		return () => { live = false; };
	}, [connection]);
	if (!open) return null;
	const hide = () => { try { localStorage.setItem(seenKey, '1'); } catch { /* shown again next time */ } setOpen(false); };
	return (
		<section className="browser-limits" aria-label="What Mob in this browser cannot do">
			{!persistent && <Notice tone="warning" title="Conversations are not saved in this browser.">It does not let Mob keep files, as in some private windows, so they are lost when the last Mob tab closes.</Notice>}
			<Notice tone="info" title="Mob is running in this browser.">
				<p>Conversations, approvals, memory, commands and token usage work, with models from providers that accept browsers. Every Mob tab in this browser shares it, and it stops when the last one closes. These need a runner:</p>
				<ul>{missing.map(m => <li key={m}>{m}</li>)}</ul>
				<div className="browser-limits-actions">
					<Button variant="outline" onClick={connect}>Connect a runner</Button>
					<Button variant="ghost" onClick={hide}>Got it</Button>
				</div>
			</Notice>
		</section>
	);
}
