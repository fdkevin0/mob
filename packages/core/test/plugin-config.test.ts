import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflareConfig, emailConfig, PluginSettings, Store, telegramConfig, type Section } from '../src';
import { openBun } from '../src/sqlite/bun';

const store = () => new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-plugins-')), 'db.sqlite'))).open();
const section = <C>(name: string, schema: Section<C>['schema'], secrets: Section<C>['secrets']): Section<C> =>
	({ name, title: name, label: name, schema, secrets, enabled: () => false, validate: () => {}, test: async () => ({}) });

const telegram = section('telegram', telegramConfig, [{ name: 'token', flag: 'hasToken' }]);
const email = section('email', emailConfig, [{ name: 'imap.password', flag: 'imap.hasPassword', owner: c => c.imap.host }]);
const cloudflare = section('cloudflare', cloudflareConfig, [{ name: 'token', flag: 'hasToken', owner: c => c.accountId }]);

test('a plugin never saved has its schema defaults', () => {
	const s = new PluginSettings(store(), [telegram, email]);
	expect(s.config().telegram).toEqual({ enabled: false, userId: 0 });
	expect(s.config().email.imap).toEqual({ host: '', port: 0, security: '', username: '' });
	expect(s.publicConfig().telegram).toEqual({ enabled: false, userId: 0, hasToken: false });
});

test('credentials are saved, kept when blank, shown only as flags and dropped when their owner changes', () => {
	const s = new PluginSettings(store(), [telegram, email, cloudflare]);
	s.update('telegram', { enabled: true, token: '1:abc', userId: 7 });
	expect(s.config().telegram.token).toBe('1:abc');
	// A form sends back the public view: the flag is accepted and dropped, the blank token keeps the saved one.
	s.update('telegram', { ...s.publicConfig().telegram, userId: 8 });
	expect(s.config().telegram).toEqual({ enabled: true, token: '1:abc', userId: 8 });
	expect(s.publicConfig().telegram).toEqual({ enabled: true, hasToken: true, userId: 8 });

	s.update('email', { imap: { host: 'a.example', password: 'p' } });
	expect(s.publicConfig().email.imap).toEqual({ host: 'a.example', port: 0, security: '', username: '', hasPassword: true });
	s.update('email', { imap: { host: 'b.example' } });
	expect(s.config().email.imap.password).toBe('');

	s.update('cloudflare', { accountId: 'x', token: 't' });
	s.update('cloudflare', { accountId: 'x', secrets: { token: { mode: 'clear' } } });
	expect(s.config().cloudflare.token).toBe('');
});

test('a configuration of the wrong shape is refused and not saved', () => {
	const s = new PluginSettings(store(), [telegram]);
	expect(() => s.update('telegram', { userId: 'seven' })).toThrow('invalid configuration');
	expect(() => s.update('telegram', { unknown: true })).toThrow('invalid configuration');
	expect(() => s.update('telegram', { userId: 1.5 })).toThrow('invalid configuration');
	expect(() => s.update('telegram', { secrets: { userId: { mode: 'clear' } } })).toThrow('unknown secret field');
	expect(s.config().telegram).toEqual({ enabled: false, userId: 0 });
});

test('an old saved configuration still loads, and saving another plugin leaves one that no longer parses as it was', () => {
	const st = store();
	const imap = { host: 'imap.example', port: 993, security: 'TLS', username: 'me', password: 'secret' };
	const stale = { enabled: false, from: 'me@example', imap, smtp: { ...imap, port: 465 }, channel: { enabled: false, owner: '', verifier: '' } };
	st.saveSetting('plugins', { email: stale, telegram: { enabled: false, userId: 0, legacy: 1 } });
	const s = new PluginSettings(st, [telegram, email]);
	// A disabled mailbox's security was free text before schemas, and still is.
	expect(s.config().email.imap).toEqual(imap);
	// Telegram's saved value has a field no schema names, so it shows as defaults, but is not overwritten by saving email.
	expect(s.config().telegram).toEqual({ enabled: false, userId: 0 });
	s.update('email', { ...s.publicConfig().email, from: 'you@example' });
	expect(st.setting<any>('plugins').telegram).toEqual({ enabled: false, userId: 0, legacy: 1 });
	expect(s.config().email.imap.password).toBe('secret');
	s.update('telegram', { userId: 3 });
	expect(st.setting<any>('plugins').email.imap.password).toBe('secret');
});
