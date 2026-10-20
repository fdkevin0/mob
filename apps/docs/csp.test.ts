import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { hashInlineScripts } from './csp';

const hash = (body: string) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
const policy = `<meta http-equiv="content-security-policy" content="script-src 'self' 'wasm-unsafe-eval'; style-src 'self';">`;
const page = (scripts: string) => `<head><meta charset="utf-8"/>${scripts}${policy}</head>`;

describe('hashInlineScripts', () => {
	test('adds each inline script to script-src and leaves other directives alone', () => {
		const html = hashInlineScripts(page('<script>a()</script><script aria-hidden="true">\n\tb()\n</script><script type="module" src="/x.js"></script>'));
		expect(html).toContain(`script-src 'self' 'wasm-unsafe-eval' ${hash('a()')} ${hash('\n\tb()\n')}; style-src 'self';`);
		expect(html).not.toContain(hash(''));
	});

	test('moves the policy ahead of the first script', () => {
		const html = hashInlineScripts(page('<script>a()</script>'));
		expect(html.startsWith(`<head><meta charset="utf-8"/><meta http-equiv="content-security-policy" content="script-src 'self' 'wasm-unsafe-eval' ${hash('a()')}; style-src 'self';">`)).toBe(true);
		expect(html.match(/content-security-policy/g)).toHaveLength(1);
	});

	test('rejects a page without a policy', () => {
		expect(() => hashInlineScripts('<script>a()</script>')).toThrow('content security policy');
	});
});
