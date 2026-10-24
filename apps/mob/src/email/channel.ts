// The email channel: Mob answers the owner's mail in INBOX, each mail thread
// in its own conversation, and replies in the thread.
import { Bridge, clientEmail, describeApproval, useText, type ConversationService, type Reply, type Store, type Texts } from '@mob/core';
import type { ImapFlow } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import { imap, maxMail, parse, send as sendMail, type Channel, type Config, type Draft, type Thread } from './mail';

/** wait is how long the loop waits after a failure, and at most between checks of INBOX while the server reports nothing. */
export const wait = { retry: 30_000, check: 10 * 60_000 };

/** Cursor is the last INBOX message the loop has handled. */
type Cursor = { validity: number; uid: number };

export const texts: Texts = {
	help: 'Mob answers your mail here. Each mail thread is its own conversation. This computer must remain running.',
	approvals: (approvals, pending) => approvals.map(a => `\n\nApproval needed: ${describeApproval(a.tool, a.input)[0]}\nID: ${a.id}`).join('') +
		(pending > 1 ? '\n\nReply with /approve ID or /deny ID and an optional reason as the first line.' : '\n\nReply with /approve, or /deny and an optional reason, as the first line.'),
	stale: id => `Approval ${id} is unknown, expired, or already decided.`,
	failed: err => `\n\nMob: ${err.message}. Open the desktop app or terminal for the saved result.`,
	unsupported: 'That command needs the desktop app or terminal.',
	empty: 'Done. Open the local conversation for details.',
	used: used => `\n\n(Used ${used.map(useText).join(', ')}. Details are in the local conversation.)`,
};

/** Incoming is a message as the channel reads it; thread are the IDs of the messages it answers, oldest first. */
export type Incoming = { id: string; thread: string[]; subject: string; text: string };

/** messageId is a message ID this channel will repeat in a header. */
const messageId = /^[^\s<>"()[\]\\,;:]{1,250}@[^\s<>"()[\]\\,;:@]{1,250}$/;

const header = (mail: ParsedMail, name: string) => {
	const v = mail.headers.get(name);
	return typeof v === 'string' ? v : v === undefined ? '' : String((v as { value?: unknown }).value ?? v);
};

/** headerValues are every value of a header, unfolded, topmost first. */
const headerValues = (mail: ParsedMail, name: string) => mail.headerLines.filter(h => h.key === name.toLowerCase()).map(h => h.line.slice(h.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim());

/** automatic reports mail a program sent on its own, such as an auto-reply, a bounce, a mailing list or Mob's own reply. */
function automatic(mail: ParsedMail) {
	const auto = header(mail, 'auto-submitted').trim().toLowerCase();
	if (auto && auto !== 'no') return true;
	if (['bulk', 'list', 'junk', 'auto_reply'].includes(header(mail, 'precedence').trim().toLowerCase())) return true;
	return headerValues(mail, 'list-id').length > 0 || headerValues(mail, 'return-path').some(v => v === '<>');
}

/**
 * fromOwner reports whether the owner alone is the sender and the topmost
 * Authentication-Results header from the verifier says the owner's domain
 * passed DMARC, or signed the mail with DKIM.
 */
function fromOwner(mail: ParsedMail, ch: Channel) {
	const from = mail.from?.value ?? [];
	if (from.length !== 1 || (from[0]!.address ?? '').toLowerCase() !== ch.owner.toLowerCase()) return false;
	const domain = ch.owner.slice(ch.owner.lastIndexOf('@') + 1).toLowerCase();
	for (let value of headerValues(mail, 'authentication-results')) {
		value = value.replace(/\([^()]*\)/g, '');
		const semi = value.indexOf(';');
		const id = semi < 0 ? value : value.slice(0, semi), results = semi < 0 ? '' : value.slice(semi + 1);
		const first = id.split(/\s+/).filter(Boolean)[0];
		if (!first || first.toLowerCase() !== ch.verifier.toLowerCase()) continue;
		// Only the provider's own header counts; it is the topmost one.
		for (const result of results.split(';')) {
			const fields = result.toLowerCase().split(/\s+/).filter(Boolean);
			if (!fields.length) continue;
			const props: Record<string, string> = {};
			for (const f of fields.slice(1)) { const i = f.indexOf('='); if (i > 0) props[f.slice(0, i)] = f.slice(i + 1).replace(/^"|"$/g, ''); }
			if (fields[0] === 'dmarc=pass' && (!('header.from' in props) || props['header.from'] === domain)) return true;
			if (fields[0] === 'dkim=pass' && (props['header.d'] === domain || (props['header.i'] ?? '').endsWith('@' + domain))) return true;
		}
		return false;
	}
	return false;
}

/** quoted starts the quoted message or signature below a reply. */
const quoted = /^(on .+ wrote:|.*写道[:：]|-{2,}\s*(original|forwarded) message\s*-{2,}|_{20,}|--)$/i;

/** fresh is what a reply adds to the thread: its text above the quoted message and the signature. */
export function fresh(text: string) {
	const lines = text.replaceAll('\r\n', '\n').split('\n');
	const end = lines.findIndex(l => { const t = l.trim(); return t.startsWith('>') || quoted.test(t); });
	return (end < 0 ? lines : lines.slice(0, end)).join('\n').trim();
}

const ids = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(/\s+/) : []).map(s => s.trim().replace(/^<|>$/g, '')).filter(Boolean);

/** incoming reads raw as mail to answer: the owner sent it, their provider verified that, and no program sent it on its own. */
export async function incoming(ch: Channel, raw: Buffer | string): Promise<Incoming | undefined> {
	let parsed;
	try { parsed = await parse(raw); } catch { return undefined; }
	const { mail, text } = parsed;
	if (automatic(mail) || !fromOwner(mail, ch)) return undefined;
	const thread: string[] = [];
	for (const id of [...ids(mail.references), ...ids(mail.inReplyTo)]) if (messageId.test(id) && !thread.includes(id)) thread.push(id);
	const own = ids(mail.messageId)[0] ?? '';
	const m: Incoming = { id: messageId.test(own) ? own : '', thread, subject: mail.subject ?? '', text: fresh(text) };
	// A command is the first line; the rest is usually a signature.
	if (m.text.startsWith('/')) m.text = m.text.split('\n')[0]!;
	else if (!thread.length && m.subject.trim()) m.text = (m.subject + '\n\n' + m.text).trim();
	return m.text ? m : undefined;
}

/** reSubject is the subject of a reply. */
export function reSubject(subject: string) {
	subject = [...subject.split(/\s+/).filter(Boolean).join(' ')].slice(0, 200).join('');
	if (!subject) return 'Re: Mob';
	return subject.toLowerCase().startsWith('re:') ? subject : 'Re: ' + subject;
}

/** newer is the UIDs after last, oldest first; SEARCH may answer in any order, and a range ending in * always includes the newest message. */
export const newer = (uids: number[], last: number) => [...new Set(uids.filter(u => u > last))].sort((a, b) => a - b);

export class Mailer {
	readonly bridge: Bridge;
	/** send sends a reply; tests replace it. */
	send: (c: Config, d: Draft, thread: Thread, signal: AbortSignal) => Promise<string> = (c, d, t, s) => sendMail(c, d, t, s);

	constructor(readonly store: Store, readonly conversation: ConversationService) {
		// The limit keeps a reply within what a draft accepts.
		this.bridge = new Bridge('Email', clientEmail, store, conversation, texts, 100 << 10);
	}

	/** loop answers new mail until signal aborts. Mail already in INBOX when it first runs is left alone. */
	async loop(c: Config, signal: AbortSignal, status: (s: string) => void) {
		const key = `email-cursor:${c.imap.username}@${c.imap.host}`;
		while (!signal.aborted) {
			try { await this.serve(c, key, signal, status); } catch (err) {
				if (signal.aborted) return;
				status((err as Error).message);
			}
			await new Promise(resolve => { const t = setTimeout(resolve, wait.retry); signal.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true }); });
		}
	}

	/** serve answers mail over one IMAP connection until it fails or signal aborts. */
	private async serve(c: Config, key: string, signal: AbortSignal, status: (s: string) => void) {
		const client = await imap(c, signal, true);
		try {
			let box;
			try { box = await client.mailboxOpen('INBOX', { readOnly: true }); } catch { throw new Error('IMAP: cannot open INBOX'); }
			let at: Cursor;
			try { at = this.store.setting<Cursor>(key) ?? { validity: 0, uid: 0 }; } catch { throw new Error('Cannot load the email cursor'); }
			const validity = Number(box.uidValidity);
			if (at.validity !== validity) {
				// The first run, or INBOX was rebuilt: answer only mail that arrives from now on.
				at = { validity, uid: Math.max(box.uidNext, 1) - 1 };
				try { this.store.saveSetting(key, at); } catch { throw new Error('Cannot save the email cursor'); }
			}
			status('Connected · answering mail from ' + c.channel.owner);
			for (;;) {
				at = await this.check(c, client, key, at, signal, status);
				// Any update may be new mail; the loop checks after each.
				const ended = await new Promise<string>(resolve => {
					const done = (why: string) => { clearTimeout(timer); client.off('exists', exists); client.off('close', closed); signal.removeEventListener('abort', aborted); resolve(why); };
					const exists = () => done('');
					const closed = () => done('IMAP: connection lost; reconnecting (server ended IDLE)');
					const aborted = () => done('aborted');
					const timer = setTimeout(() => done(''), wait.check);
					client.on('exists', exists);
					client.on('close', closed);
					signal.addEventListener('abort', aborted, { once: true });
				});
				if (signal.aborted) return;
				if (ended) throw new Error(ended);
			}
		} finally { client.close(); }
	}

	/** check answers the mail after at, moving the cursor past each message. */
	private async check(c: Config, client: ImapFlow, key: string, at: Cursor, signal: AbortSignal, status: (s: string) => void): Promise<Cursor> {
		let uids: number[];
		try { uids = (await client.search({ uid: `${at.uid + 1}:*` }, { uid: true })) || []; } catch { throw new Error('IMAP: cannot search INBOX'); }
		for (const uid of newer(uids, at.uid)) {
			const raw = await fetch(client, uid);
			if (raw) {
				try { await this.answer(c, at.validity, uid, raw, signal); } catch (err) {
					const id = (err as { delivery?: string }).delivery ?? '';
					status((err as Error).message);
					if (signal.aborted) throw err;
					// Mail whose delivery was never recorded is tried again.
					let accepted = false;
					try { accepted = !!id && this.store.deliveryAccepted(id); } catch { /* tried again */ }
					if (!accepted) throw err;
				}
			}
			at = { ...at, uid };
			try { this.store.saveSetting(key, at); } catch { throw new Error('Cannot save the email cursor; stopped answering mail'); }
		}
		return at;
	}

	/** answer answers raw, the message uid in INBOX, if the owner sent it, and replies once; it returns the delivery it is recorded under. */
	async answer(c: Config, validity: number, uid: number, raw: Buffer | string, signal: AbortSignal): Promise<string> {
		const m = await incoming(c.channel, raw);
		if (!m) return '';
		const id = m.id ? 'mail:' + m.id : `mail:${validity}:${uid}`;
		const root = m.thread[0] ?? (m.id || id);
		const message = { id, key: 'email-thread:' + root, owner: true, text: m.text };
		const thread: Thread = m.id ? { inReplyTo: m.id, references: [...m.thread, m.id] } : {};
		try {
			await this.bridge.deliver(id, s => this.bridge.answer(message, s), async (r: Reply, s) => { await this.send(c, { to: c.channel.owner, subject: reSubject(m.subject), text: r.text }, thread, s); }, signal);
		} catch (err) { throw Object.assign(err as Error, { delivery: id }); }
		return id;
	}
}

/** fetch reads a whole message without marking it read, or undefined for one too large to answer; its size is asked first. */
async function fetch(client: ImapFlow, uid: number) {
	let size;
	try { size = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true }); } catch { throw new Error('IMAP: could not read new mail'); }
	if (!size || !size.size || size.size > maxMail) return undefined;
	try {
		const m = await client.fetchOne(String(uid), { uid: true, source: { start: 0, maxLength: maxMail } }, { uid: true });
		return m ? m.source : undefined;
	} catch { throw new Error('IMAP: could not read new mail'); }
}
