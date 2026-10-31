// @vitest-environment node
import { createHmac, createPublicKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { expect, it } from 'vitest';
import { appJWT, mentions, metadata, narrow, pkcs8, verify } from '../worker/github-app';

it('checks webhook signatures', async () => {
	const body = '{"zen":"Keep it logically awesome."}';
	const good = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
	expect(await verify('secret', body, good)).toBe(true);
	expect(await verify('other', body, good)).toBe(false);
	expect(await verify('secret', body + ' ', good)).toBe(false);
	expect(await verify('secret', body, null)).toBe(false);
	expect(await verify('secret', body, good.replace('sha256=', 'sha1='))).toBe(false);
	expect(await verify('', body, good)).toBe(false);
});

it('finds the app named as a whole word', () => {
	expect(mentions('@usemob please fix', 'usemob')).toBe(true);
	expect(mentions('ping @UseMob.', 'usemob')).toBe(true);
	expect(mentions('@usemobile', 'usemob')).toBe(false);
	expect(mentions('mail me@usemob', 'usemob')).toBe(false);
	expect(mentions('see org/@usemob', 'usemob')).toBe(false);
	expect(mentions(undefined, 'usemob')).toBe(false);
});

const base = { installation: { id: 7 }, repository: { full_name: 'fdkevin0/mob' }, sender: { login: 'fdkevin0', id: 25277753, type: 'User' } };

it('keeps only routing metadata of an event', () => {
	const labeled = metadata('issues', 'd1', {
		...base, action: 'labeled', label: { name: 'mob:quick' },
		issue: { number: 12, title: 'Secret title', body: 'Secret body', author_association: 'OWNER' },
	}, 'usemob', 1000);
	expect(labeled).toEqual({
		delivery: 'd1', event: 'issues', action: 'labeled', installation: 7, repo: 'fdkevin0/mob', number: 12, pull: false,
		association: 'OWNER', label: 'mob:quick', sender: { login: 'fdkevin0', id: 25277753, bot: false }, at: 1000,
	});
	expect(JSON.stringify(labeled)).not.toContain('Secret');

	const comment = metadata('issue_comment', 'd2', {
		...base, action: 'created',
		issue: { number: 3, pull_request: { url: 'x' }, author_association: 'NONE' },
		comment: { id: 99, body: '@usemob review this', author_association: 'MEMBER' },
	}, 'usemob');
	expect(comment).toMatchObject({ number: 3, pull: true, comment: 99, mention: true, association: 'MEMBER' });
	expect(JSON.stringify(comment)).not.toContain('review this');

	const bot = metadata('issue_comment', 'd3', { ...base, action: 'created', sender: { login: 'usemob[bot]', id: 5, type: 'Bot' }, issue: { number: 3 }, comment: { id: 1, body: '' } }, 'usemob');
	expect(bot?.sender.bot).toBe(true);

	const suite = metadata('check_suite', 'd4', { ...base, action: 'completed', check_suite: { conclusion: 'failure', pull_requests: [{ number: 5 }, { number: 'x' }] } }, 'usemob');
	expect(suite).toMatchObject({ conclusion: 'failure', pulls: [5] });
});

it('drops events Mob does not act on', () => {
	expect(metadata('issues', 'd', { ...base, action: 'pinned', issue: { number: 1 } }, 'usemob')).toBeUndefined();
	expect(metadata('push', 'd', { ...base, action: '' }, 'usemob')).toBeUndefined();
	expect(metadata('issues', 'd', { ...base, installation: undefined, action: 'opened', issue: { number: 1 } }, 'usemob')).toBeUndefined();
	expect(metadata('issues', 'd', { ...base, repository: { full_name: '../x' }, action: 'opened', issue: { number: 1 } }, 'usemob')).toBeUndefined();
});

it('grants no more than runners may have', () => {
	expect(narrow({ contents: 'write', pull_requests: 'write', metadata: 'read' })).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read' });
	expect(narrow({ workflows: 'write' })).toContain('not granted');
	expect(narrow({ administration: 'read' })).toContain('not granted');
	expect(narrow({ checks: 'write' })).toContain('read-only');
	expect(narrow({ issues: 'admin' })).toContain('read or write');
	expect(narrow({})).toContain('at least one');
	expect(narrow(['contents'])).toContain('object');
});

it('signs the app JWT with the PKCS#1 key GitHub hands out', async () => {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
	expect(Buffer.from(pkcs8(pem)).equals(privateKey.export({ type: 'pkcs8', format: 'der' }))).toBe(true);
	// Secrets pasted on one line keep their newlines as \n.
	const jwt = await appJWT('123', pem.replace(/\n/g, '\\n'), 1_700_000_000_000);
	const [header, payload, signature] = jwt.split('.');
	expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
	expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: '123' });
	expect(verifySignature('sha256', Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature!, 'base64url'))).toBe(true);
});
