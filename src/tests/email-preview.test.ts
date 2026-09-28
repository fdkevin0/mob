import { describe, it, expect } from 'vitest';
import { buildEmailPreviewData, inlineCidImages, type PreviewMeta } from '../features/email/preview';

const META: PreviewMeta = {
	subject: 'Hello <world> & "friends"',
	from: 'sender@example.com',
	to: 'bot@example.com',
	date: '2026-07-03',
	spam: false,
	authResults: null,
};

/**
 * Email preview behavior (docs/adr/0035): `cid:` inlining and the parsed-email
 * payload rendered by the Mini App detail screen.
 */
describe('buildEmailPreviewData — html body', () => {
	it('preserves the html body (client sets it as srcdoc); text is null; metadata carried through', () => {
		const data = buildEmailPreviewData({ html: '<p>Hi <b>there</b></p>' }, META);
		expect(data.html !== null && data.html.includes('<p>Hi <b>there</b></p>')).toBe(true);
		expect(data.text).toBeNull();
		expect(data.subject === META.subject && data.from === META.from).toBe(true);
	});
});

describe('buildEmailPreviewData — html shim', () => {
	it('injects viewport + charset into a fragment, wrapped in body', () => {
		const frag = buildEmailPreviewData({ html: '<p>hi</p>' }, META).html!;
		expect(frag.includes('name="viewport"') && frag.includes('charset="utf-8"')).toBe(true);
		expect(frag.includes('<body') && frag.includes('<p>hi</p>')).toBe(true);
	});

	it('injects the shim into an existing head without double-wrapping a full document', () => {
		const full = buildEmailPreviewData({ html: '<html><head><title>x</title></head><body>hi</body></html>' }, META).html!;
		expect(full.indexOf('<html') === full.lastIndexOf('<html')).toBe(true);
		expect(full.includes('name="viewport"') && full.includes('<title>x</title>')).toBe(true);
	});
});

describe('buildEmailPreviewData — spam + auth', () => {
	it('no auth header → spam false, auth null; auth mechanisms parsed per-mechanism', () => {
		const clean = buildEmailPreviewData({ text: 'body' }, META);
		expect(clean.spam === false && clean.auth === null).toBe(true);
		const flagged = buildEmailPreviewData(
			{ text: 'body' },
			{ ...META, spam: true, authResults: 'mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail' }
		);
		expect(flagged.spam).toBe(true);
		expect(flagged.auth?.spf === 'fail' && flagged.auth?.dkim === 'none' && flagged.auth?.dmarc === 'fail').toBe(true);
	});
});

describe('buildEmailPreviewData — text body / missing body', () => {
	it('passes the text body through; no html for a text-only email', () => {
		const data = buildEmailPreviewData({ text: 'line1\n<tag> & stuff' }, META);
		expect(data.text).toBe('line1\n<tag> & stuff');
		expect(data.html).toBeNull();
	});

	it('a vanished .eml has no body but keeps header metadata; a bodiless email is also no-body', () => {
		const gone = buildEmailPreviewData(null, META);
		expect(gone.html === null && gone.text === null).toBe(true);
		expect(gone.subject).toBe(META.subject);
		const empty = buildEmailPreviewData({}, META);
		expect(empty.html === null && empty.text === null).toBe(true);
	});
});

describe('inlineCidImages', () => {
	it('turns matched cid into a data uri; leaves unmatched and over-budget cids as-is', () => {
		const html = '<img src="cid:logo@x"><img src="cid:other@x">';
		const inlined = inlineCidImages(html, [
			{ contentId: '<logo@x>', mimeType: 'image/png', content: new Uint8Array([1, 2, 3]) },
		]);
		expect(inlined.includes('data:image/png;base64,AQID')).toBe(true);
		expect(inlined.includes('cid:other@x')).toBe(true);
		// Over-budget attachments are skipped, not truncated (docs/adr/0035).
		const big = new Uint8Array(3 * 1024 * 1024);
		const capped = inlineCidImages('<img src="cid:big@x">', [
			{ contentId: 'big@x', mimeType: 'image/png', content: big },
		]);
		expect(capped.includes('cid:big@x')).toBe(true);
	});
});

describe('buildEmailPreviewData — attachment listing', () => {
	it('excludes inline cid attachments; lists non-inline with size', () => {
		const data = buildEmailPreviewData(
			{
				text: 'body',
				attachments: [
					{ filename: 'report.pdf', disposition: 'attachment', content: new Uint8Array(2048) },
					{ filename: 'logo.png', disposition: 'inline', contentId: '<logo@x>', content: new Uint8Array(10) },
				],
			},
			META
		);
		expect(data.attachments.length).toBe(1);
		expect(data.attachments[0].filename === 'report.pdf' && data.attachments[0].size === 2048).toBe(true);
	});
});