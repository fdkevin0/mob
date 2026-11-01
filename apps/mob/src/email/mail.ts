// The optional SMTP and IMAP protocol and the mail use cases.
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import type { EmailChannel, EmailConfig, Endpoint } from '@mob/core';

export type { Endpoint } from '@mob/core';
export type Config = EmailConfig;
/** Channel is whether and to whom Mob answers mail in INBOX. */
export type Channel = EmailChannel;

type Address = { name: string; address: string };

/** addresses parses a list of addresses; groups are flattened. */
export function addresses(text: string): Address[] {
	const out: Address[] = [];
	const walk = (list: { name?: string; address?: string; group?: unknown[] }[]) => {
		for (const a of list) a.group ? walk(a.group as never) : out.push({ name: a.name ?? '', address: a.address ?? '' });
	};
	walk(addressparser(text));
	return out;
}

const validAddress = (a: Address) => /^[^\s@<>]+@[^\s@<>]+$/.test(a.address);

/** address is text as one valid address, or undefined. */
export function address(text: string) {
	const list = addresses(text);
	return list.length === 1 && validAddress(list[0]!) ? list[0] : undefined;
}

export const formatAddress = (a: Address) => a.name ? `${/[^\w !#$%&'*+\-/=?^`{|}~.]/.test(a.name) ? JSON.stringify(a.name) : a.name} <${a.address}>` : `<${a.address}>`;

export function validate(c: Config) {
	if (!c.enabled) return;
	if (!address(c.from) || /[\r\n]/.test(c.from)) throw new Error('email: enter a valid From address');
	for (const e of [c.imap, c.smtp]) {
		if (!e.host || /[/\r\n \t]/.test(e.host) || e.port < 1 || e.port > 65535 || !e.username || !e.password) throw new Error('email: host, port, username and password are required for IMAP and SMTP');
		if (e.security !== 'tls' && e.security !== 'starttls') throw new Error('email: choose TLS or STARTTLS');
	}
	if (c.channel.enabled) {
		const owner = address(c.channel.owner);
		if (!owner || owner.address !== c.channel.owner) throw new Error("email: enter the owner's address to answer mail from");
		if (!c.channel.verifier || /[; \t\r\n]/.test(c.channel.verifier)) throw new Error('email: enter the authserv-id your provider writes in Authentication-Results, such as mx.google.com');
	}
}

export function active(c: Config) {
	if (!c.enabled) throw new Error('email plugin is disabled');
	validate(c);
}

const tlsOptions = (e: Endpoint) => ({ servername: e.host, minVersion: 'TLSv1.2' as const });

/** imap signs in to IMAP; a session for the channel stays open until it is closed. */
export async function imap(c: Config, signal?: AbortSignal, idle = false): Promise<ImapFlow> {
	const e = c.imap;
	const client = new ImapFlow({
		host: e.host, port: e.port, secure: e.security === 'tls', doSTARTTLS: e.security === 'starttls' ? true : undefined,
		auth: { user: e.username, pass: e.password ?? '' }, tls: tlsOptions(e), logger: false,
		connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: idle ? 30 * 60_000 : 25_000,
		maxIdleTime: idle ? 9 * 60_000 : undefined, disableAutoIdle: !idle,
	});
	client.on('error', () => { /* the operation that was waiting reports it */ });
	const abort = () => client.close();
	signal?.addEventListener('abort', abort, { once: true });
	try { await client.connect(); } catch (err) {
		signal?.removeEventListener('abort', abort);
		client.close();
		if ((err as { authenticationFailed?: boolean }).authenticationFailed || /auth|login|tls/i.test((err as Error).message)) throw new Error('IMAP: TLS or login failed; check credentials/app password');
		throw new Error('email: connection failed; check host and port');
	}
	return client;
}

/** transport is the SMTP connection of c. */
function transport(c: Config) {
	const e = c.smtp;
	return nodemailer.createTransport({
		host: e.host, port: e.port, secure: e.security === 'tls', requireTLS: e.security === 'starttls',
		auth: { user: e.username, pass: e.password ?? '' }, tls: tlsOptions(e),
		connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 25_000,
	});
}

export async function test(c: Config, signal?: AbortSignal) {
	active(c);
	const client = await imap(c, signal);
	await client.logout().catch(() => client.close());
	const t = transport(c);
	try { await t.verify(); } catch { throw new Error('SMTP: TLS or login failed; check credentials/app password'); } finally { t.close(); }
	return { ok: true };
}

export type Summary = { uid: number; validity: number; subject: string; from: string; date: string };
export type Mail = Summary & { text: string; attachments: string[] };

type Envelope = { subject?: string; date?: Date | string; from?: { name?: string; address?: string }[] };

function summary(uid: number, validity: number, e: Envelope): Summary {
	const date = e.date ? new Date(e.date) : undefined;
	return { uid, validity, subject: e.subject ?? '', from: (e.from ?? []).map(a => formatAddress({ name: a.name ?? '', address: a.address ?? '' })).join(', '), date: date && !Number.isNaN(date.getTime()) ? date.toISOString().replace(/\.\d+Z$/, 'Z') : '' };
}

/** withInbox opens INBOX read-only for fn and signs out after. */
async function withInbox<T>(c: Config, signal: AbortSignal | undefined, fn: (client: ImapFlow, validity: number, exists: number) => Promise<T>): Promise<T> {
	active(c);
	const client = await imap(c, signal);
	try {
		let box;
		try { box = await client.mailboxOpen('INBOX', { readOnly: true }); } catch { throw new Error('IMAP: cannot open INBOX'); }
		return await fn(client, Number(box.uidValidity), box.exists);
	} finally { await client.logout().catch(() => client.close()); }
}

/** inbox lists the 50 newest INBOX messages, newest first. */
export function inbox(c: Config, signal?: AbortSignal): Promise<Summary[]> {
	return withInbox(c, signal, async (client, validity, exists) => {
		if (!exists) return [];
		const list: Summary[] = [];
		try {
			for await (const m of client.fetch(`${Math.max(1, exists - 49)}:${exists}`, { uid: true, envelope: true })) if (m.envelope) list.push(summary(m.uid, validity, m.envelope));
		} catch { throw new Error('IMAP: could not read inbox'); }
		return list.reverse();
	});
}

/** maxMail is the largest message read; larger ones are not downloaded. */
export const maxMail = 2 << 20;

export function read(c: Config, uid: number, validity: number, signal?: AbortSignal): Promise<Mail> {
	return withInbox(c, signal, async (client, current) => {
		if (validity !== current) throw new Error('INBOX changed; refresh the message list');
		let m;
		try { m = await client.fetchOne(String(uid), { uid: true, envelope: true, size: true, source: { start: 0, maxLength: maxMail } }, { uid: true }); } catch { throw new Error('IMAP: could not read message'); }
		if (!m || !m.envelope) throw new Error('message no longer exists; refresh INBOX');
		if ((m.size ?? 0) > maxMail) throw new Error('message exceeds the 2 MiB preview limit');
		if (!m.source) throw new Error('message body unavailable');
		const { text, attachments } = await parse(m.source);
		return { ...summary(m.uid, validity, m.envelope), text, attachments };
	});
}

/** parse reads a message's text, preferring plain text to HTML, and its attachments' names. */
export async function parse(raw: Buffer | string): Promise<{ mail: ParsedMail; text: string; attachments: string[] }> {
	let mail: ParsedMail;
	try { mail = await simpleParser(typeof raw === 'string' ? raw : raw.subarray(0, maxMail), { skipImageLinks: true, skipTextToHtml: true }); } catch { throw new Error('cannot decode email'); }
	const text = mail.text?.trim() ? mail.text : mail.html ? plainHTML(mail.html) : '';
	return { mail, text, attachments: mail.attachments.filter(a => a.contentDisposition === 'attachment' || a.filename).map(a => a.filename ?? '') };
}

/** plainHTML is the text of HTML, without scripts and styles. */
export function plainHTML(raw: string) {
	return raw.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<(br|p|div)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
		.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e.toLowerCase()]!).trim();
}

export type Draft = { to: string; subject: string; text: string };

export function validateDraft(d: Draft) {
	if (typeof d.to !== 'string' || typeof d.subject !== 'string' || typeof d.text !== 'string' || /[\r\n]/.test(d.to + d.subject) || new TextEncoder().encode(d.subject).length > 1000 || new TextEncoder().encode(d.text).length > 128 << 10 || !d.text.trim()) {
		throw new Error('enter a recipient, single-line subject and message (max 128 KiB)');
	}
	const list = addresses(d.to);
	if (!list.length || list.length > 20 || !list.every(validAddress)) throw new Error('enter 1–20 valid recipients');
}

/** Thread keeps a reply in its thread. */
export type Thread = { inReplyTo?: string; references?: string[] };

/**
 * send sends d and returns its message ID. A reply in a thread is marked as
 * sent by a program, so no one's auto-reply answers it.
 */
export async function send(c: Config, d: Draft, thread?: Thread, signal?: AbortSignal): Promise<string> {
	active(c);
	validateDraft(d);
	const from = address(c.from)!;
	const id = `${crypto.randomUUID().replaceAll('-', '')}@${from.address.slice(from.address.lastIndexOf('@') + 1)}`;
	const t = transport(c);
	const abort = () => t.close();
	signal?.addEventListener('abort', abort, { once: true });
	try {
		await t.sendMail({
			from: { name: from.name, address: from.address }, to: addresses(d.to).map(a => ({ name: a.name, address: a.address })), subject: d.subject, text: d.text,
			messageId: `<${id}>`, date: new Date(), textEncoding: 'quoted-printable',
			...thread ? { headers: { 'Auto-Submitted': 'auto-replied' }, ...thread.inReplyTo ? { inReplyTo: `<${thread.inReplyTo}>`, references: thread.references?.map(r => `<${r}>`) } : {} } : {},
		});
	} catch (err) {
		const e = err as { code?: string; responseCode?: number; command?: string };
		if (e.code === 'EAUTH' || e.code === 'ETLS') throw new Error('SMTP: TLS or login failed; check credentials/app password');
		if (e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'EDNS') throw new Error('email: connection failed; check host and port');
		if (e.command === 'MAIL FROM') throw new Error('SMTP rejected sender');
		if (e.command === 'RCPT TO') throw new Error('SMTP rejected recipient');
		throw new Error('SMTP delivery status unknown; check the recipient before retrying');
	} finally {
		signal?.removeEventListener('abort', abort);
		t.close();
	}
	return id;
}
