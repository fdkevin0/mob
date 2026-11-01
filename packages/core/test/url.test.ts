import { expect, test } from 'bun:test';
import { isLoopbackHost, secureURL, validateURL, webOrigin } from '../src';

test('loopback is localhost, 127.0.0.0/8 and ::1, and nothing that only starts like them', () => {
	for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(h)).toBe(true);
	for (const h of ['127.example.com', '127.0.0.1.example.com', 'localhost.example.com', '10.0.0.1', '::2', '']) expect(isLoopbackHost(h)).toBe(false);
});

test('a credential travels over HTTPS, or HTTP only to loopback', () => {
	expect(secureURL(new URL('https://example.com'))).toBe(true);
	expect(secureURL(new URL('http://127.0.0.1:8080'))).toBe(true);
	expect(secureURL(new URL('http://[::1]:3000'))).toBe(true);
	expect(secureURL(new URL('http://127.example.com'))).toBe(false);
	expect(secureURL(new URL('ftp://localhost'))).toBe(false);
	expect(() => validateURL('http://127.example.com/v1')).toThrow('HTTPS');
	expect(() => webOrigin('http://127.example.com')).toThrow('web_url');
	expect(webOrigin('http://127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173');
});
