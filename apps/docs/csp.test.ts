import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { hashInlineScripts } from './csp';

const hash = (body: string) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
const page = (scripts: string) =>
	`<head><meta http-equiv="content-security-policy" content="script-src 'self' 'wasm-unsafe-eval'; style-src 'self';">${scripts}</head>`;

describe('hashInlineScripts', () => {
	test('adds each inline script to script-src and leaves other directives alone', () => {
		const html = hashInlineScripts(page('<script>a()</script><script aria-hidden="true">\n\tb()\n</script><script type="module" src="/x.js"></script>'));
		expect(html).toContain(`script-src 'self' 'wasm-unsafe-eval' ${hash('a()')} ${hash('\n\tb()\n')}; style-src 'self';`);
		expect(html).not.toContain(hash(''));
	});

	test('rejects a page without a policy', () => {
		expect(() => hashInlineScripts('<script>a()</script>')).toThrow('content security policy');
	});
});
