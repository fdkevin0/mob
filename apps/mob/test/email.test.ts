import { expect, test } from 'bun:test';
import { ConversationService, DemoModel, emailConfig, Store, type Models } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { incoming, Mailer, newer, reSubject } from '../src/email/channel';
import { recipients } from '../src/email';
import { address, parse, plainHTML, validate, validateDraft, type Config } from '../src/email/mail';

const owner = { enabled: true, owner: 'me@example.org', verifier: 'mx.example.net' };

/** ownerMail is a message from the owner, verified by their provider unless header says otherwise. */
function ownerMail(header: string, body: string) {
	if (!header.includes('Authentication-Results')) header = 'Authentication-Results: mx.example.net; spf=pass; dkim=pass header.d=example.org; dmarc=pass (p=reject) header.from=example.org\r\n' + header;
	if (!header.includes('From:')) header += 'From: Me <me@example.org>\r\n';
	return header + 'Content-Type: text/plain; charset=UTF-8\r\n\r\n' + body;
}

test('only the verified owner is answered', async () => {
	const refused: Record<string, string> = {
		'another sender': ownerMail('From: Eve <eve@example.org>\r\n', 'hi'),
		'two senders': ownerMail('From: me@example.org, eve@example.org\r\n', 'hi'),
		'no verification': ownerMail('Authentication-Results: other.example; dmarc=pass header.from=example.org\r\n', 'hi'),
		'failed DMARC': ownerMail('Authentication-Results: mx.example.net; dkim=fail; dmarc=fail header.from=example.org\r\n', 'hi'),
		'another domain': ownerMail('Authentication-Results: mx.example.net; dkim=pass header.d=evil.example; dmarc=none\r\n', 'hi'),
		'forged lower down': ownerMail('Authentication-Results: mx.example.net; dmarc=fail header.from=example.org\r\nAuthentication-Results: mx.example.net; dmarc=pass header.from=example.org\r\n', 'hi'),
		'an auto-reply': ownerMail('Auto-Submitted: auto-replied\r\n', 'hi'),
		'a mailing list': ownerMail('List-Id: <news.example.org>\r\n', 'hi'),
		'nothing new': ownerMail('References: <a@example.org>\r\n', '> quoted'),
	};
	for (const [name, raw] of Object.entries(refused)) expect([name, await incoming(owner, raw)]).toEqual([name, undefined]);
	const answered: Record<string, string> = {
		DMARC: ownerMail('', 'hi'),
		DKIM: ownerMail('Authentication-Results: mx.example.net (comment; here); dkim=pass header.i=@example.org\r\n', 'hi'),
		case: ownerMail('From: ME@Example.org\r\n', 'hi'),
	};
	for (const [name, raw] of Object.entries(answered)) expect([name, !!await incoming(owner, raw)]).toEqual([name, true]);
});

test('a reply keeps what it adds', async () => {
	let m = await incoming(owner, ownerMail('Message-ID: <b@example.org>\r\nIn-Reply-To: <a@example.org>\r\nReferences: <root@example.org> <a@example.org>\r\nSubject: Re: plans\r\n',
		'Sounds good.\r\nThanks\r\n\r\nOn Mon, 12 Oct 2026, Mob <mob@example.org> wrote:\r\n> earlier\r\n'));
	expect(m).toEqual({ id: 'b@example.org', thread: ['root@example.org', 'a@example.org'], subject: 'Re: plans', text: 'Sounds good.\nThanks' });
	m = await incoming(owner, ownerMail('Subject: Weekend plans\r\n', "What's on?\r\n-- \r\nMe"));
	expect([m?.text, m?.thread]).toEqual(["Weekend plans\n\nWhat's on?", []]);
	m = await incoming(owner, ownerMail('Subject: Re: x\r\nReferences: <a@example.org>\r\n', '/approve\r\nSent from my phone\r\n在 2026年10月12日，Mob 写道：\r\n> x'));
	expect(m?.text).toBe('/approve');
	expect([reSubject('RE: x'), reSubject(' plans '), reSubject('')]).toEqual(['RE: x', 'Re: plans', 'Re: Mob']);
	expect(newer([5, 3, 9, 3, 2], 3)).toEqual([5, 9]);
});

test('mail parsing and validation', async () => {
	const { text, attachments } = await parse('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Hi<script>x</script> &amp; bye</p>\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\n\r\nxx\r\n--b--\r\n');
	expect(text).toContain('Hi & bye');
	expect(attachments).toEqual(['a.pdf']);
	expect(plainHTML('<style>p{}</style>a<br>b')).toBe('a\nb');
	expect(address('Me <me@example.org>')).toEqual({ name: 'Me', address: 'me@example.org' });
	expect(address('a@b, c@d')).toBeUndefined();
	expect(() => validateDraft({ to: 'a@example.org', subject: 'x\ny', text: 'hi' })).toThrow('single-line');
	expect(() => validateDraft({ to: 'nobody', subject: 'x', text: 'hi' })).toThrow('valid recipients');
	validateDraft({ to: 'A <a@example.org>, b@example.org', subject: 'x', text: 'hi' });
	const c: Config = { ...emailConfig.parse({}), enabled: true, from: 'me@example.org', imap: { host: 'imap.example.org', port: 993, security: 'tls', username: 'me', password: 'p' }, smtp: { host: 'smtp.example.org', port: 465, security: 'tls', username: 'me', password: 'p' } };
	validate(c);
	expect(() => validate({ ...c, imap: { ...c.imap, security: 'none' } })).toThrow('TLS or STARTTLS');
	expect(() => validate({ ...c, channel: { enabled: true, owner: 'Me <me@example.org>', verifier: 'mx' } })).toThrow("owner's address");
	expect(recipients('B@x.org, a@x.org,b@x.org')).toBe('a@x.org, b@x.org');
});

test('the owner’s mail is answered once, in its thread', async () => {
	const models: Models = { default: () => 'demo/echo', resolve: () => new DemoModel(), setDefault: () => new DemoModel().ref, list: async () => [] };
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-mail-')), 'mob.sqlite'))).open();
	const m = new Mailer(store, new ConversationService(store, models));
	const replies: unknown[] = [];
	m.send = async (_c, d, thread) => { replies.push({ d, thread }); return 'id'; };
	const c = { ...emailConfig.parse({}), channel: owner };
	const raw = ownerMail('Message-ID: <b@example.org>\r\nReferences: <a@example.org>\r\nSubject: plans\r\n', 'hello there');
	const signal = new AbortController().signal;
	expect(await m.answer(c, 1, 7, raw, signal)).toBe('mail:b@example.org');
	await m.answer(c, 1, 7, raw, signal);
	expect(replies).toHaveLength(1);
	expect(replies[0]).toMatchObject({ d: { to: 'me@example.org', subject: 'Re: plans' }, thread: { inReplyTo: 'b@example.org', references: ['a@example.org', 'b@example.org'] } });
	expect((replies[0] as { d: { text: string } }).d.text).toContain('Received: hello there');
	expect(store.setting<string>('email-thread:a@example.org')).toBeTruthy();
	expect(await m.answer(c, 1, 8, ownerMail('From: eve@example.org\r\n', 'hi'), signal)).toBe('');
});
