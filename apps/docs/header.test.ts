import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

// The docs header's inline account script, run as the page runs it.
const source = await readFile(new URL('./src/components/Header.astro', import.meta.url), 'utf8');
const script = source.match(/<script is:inline>([\s\S]*?)<\/script>/)![1];

// A page prerendered on hover checks the session before the visitor opens it;
// signing out on the current page in between must not leave the old account.
test('the docs header checks the session again when a prerendered page is shown', async () => {
	const window = new Window({ url: 'https://usemob.app/docs/' });
	window.document.body.innerHTML = '<div id="site-user"><a class="site-user site-login" href="/?signin=account">Log in</a></div>';
	let user: object | null = { name: 'Ada', email: 'ada@example.test', image: null };
	let calls = 0;
	window.fetch = (async () => { calls++; return new window.Response(JSON.stringify(user ? { user } : null), { headers: { 'Content-Type': 'application/json' } }); }) as never;
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
	const slot = () => window.document.querySelector('#site-user > *')!;

	window.eval(script);
	await settle();
	expect(slot().getAttribute('href')).toBe('/account');
	user = null;
	window.document.dispatchEvent(new window.Event('prerenderingchange'));
	await settle();
	expect(calls).toBe(2);
	expect(slot().textContent).toBe('Log in');
	expect(window.localStorage.getItem('mob-account-hint')).toBeNull();
	await window.happyDOM.close();
});
