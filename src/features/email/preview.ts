/**
 * The **Email preview** module (docs/adr/0035):
 * the pure pieces behind viewing a stored email's full body. Originally a
 * server-rendered HTML page behind a bearer-token capability URL; ADR-0035
 * moved auth to the Settings Mini App's `initData` scheme, so this module now
 * only builds the JSON payload the shell's client JS renders into a sandboxed
 * `srcdoc` iframe — no HTML templating or token codec lives here anymore.
 */
import { createDocument } from '@mixmark-io/domino';
import { parseAuthResults } from './auth';

/**
 * The subset of a parsed email the renderer needs. Structurally compatible
 * with PostalMime's `Email`, but declared here so tests build fakes without
 * pulling in the parser.
 */
export interface PreviewEmail {
	subject?: string | null;
	html?: string | null;
	text?: string | null;
	attachments?: PreviewAttachment[];
}

export interface PreviewAttachment {
	filename?: string | null;
	mimeType?: string | null;
	/** MIME Content-ID (angle brackets included or not), for `cid:` references. */
	contentId?: string | null;
	disposition?: string | null;
	content?: ArrayBuffer | Uint8Array | string | null;
}

/** Header-bar metadata, from the D1 row (not the parsed body). */
export interface PreviewMeta {
	subject: string;
	from: string;
	to: string;
	date: string;
	/** Inbound auth verdict (docs/adr/0009): drives the SPAM badge. */
	spam: boolean;
	/** Raw `Authentication-Results` header, parsed for the per-mechanism line. `null` on legacy rows. */
	authResults: string | null;
}

/** A listed (non-inline) attachment, display-only — never downloadable (docs/adr/0035). */
export interface PreviewAttachmentSummary {
	filename: string;
	size: number;
}

/**
 * The JSON shape the Mini App's email detail screen fetches and renders
 * client-side: header metadata plus a body that is *either* HTML (already
 * `cid:`-inlined, to be set as an `<iframe sandbox="">`'s `srcdoc`) *or*
 * plain text (rendered as an escaped `<pre>` by the client), never both.
 */
export interface EmailPreviewData {
	subject: string;
	from: string;
	to: string;
	date: string;
	html: string | null;
	text: string | null;
	attachments: PreviewAttachmentSummary[];
	/** True → the detail screen shows a SPAM badge (docs/adr/0009). */
	spam: boolean;
	/** Per-mechanism auth verdicts for the detail screen; `null` on legacy rows with no stored header. */
	auth: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
}

/** Total base64 budget for inlined `cid:` images (docs/adr/0035). */
const CID_INLINE_BUDGET = 2 * 1024 * 1024;

function toBase64(content: ArrayBuffer | Uint8Array | string): string {
	const bytes =
		typeof content === 'string'
			? new TextEncoder().encode(content)
			: content instanceof Uint8Array
				? content
				: new Uint8Array(content);
	let binary = '';
	const CHUNK = 0x8000; // String.fromCharCode arg-count limit
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/**
 * Rewrite `cid:` references to base64 `data:` URIs from the email's own
 * attachments, within a total size budget; over budget they are left as-is
 * (docs/adr/0035 — a pathological email must not blow up the response).
 */
export function inlineCidImages(html: string, attachments: PreviewAttachment[]): string {
	let budget = CID_INLINE_BUDGET;
	let result = html;
	for (const attachment of attachments) {
		if (!attachment.contentId || attachment.content == null) continue;
		const cid = attachment.contentId.replace(/^<|>$/g, '');
		const ref = `cid:${cid}`;
		if (!result.includes(ref)) continue;
		const base64 = toBase64(attachment.content);
		if (base64.length > budget) continue;
		budget -= base64.length;
		result = result.split(ref).join(`data:${attachment.mimeType || 'image/png'};base64,${base64}`);
	}
	return result;
}

/**
 * The `<head>` shim injected into an email body before it becomes the sandboxed
 * iframe's `srcdoc`. Desktop-authored email HTML overflows a phone-width Mini
 * App viewport with no viewport meta; the iframe runs no JS (`sandbox=""`), so
 * this static normalization is the only lever. `charset` guards against mojibake
 * when the original body declared a non-UTF-8 charset. Styles are intentionally
 * minimal — `overflow-x:auto` allows wide emails to scroll horizontally rather
 * than forcibly squashing their layout (issue #109).
 */
const HEAD_SHIM =
	'<meta charset="utf-8">' +
	'<meta name="viewport" content="width=device-width,initial-scale=1">' +
	'<style>' +
	'html{-webkit-text-size-adjust:100%;overflow-x:auto}' +
	'img,video{max-width:100%;height:auto}' +
	'table{max-width:none}' +
	'body{margin:0}' +
	'</style>';

/**
 * Make an email HTML body fit the Mini App viewport by injecting {@link HEAD_SHIM}.
 * Parsed with Domino so the shim lands in the document's real `<head>` — the
 * former regex injection misfired when a `<head>`-looking string sat inside a
 * comment or attribute. A bare fragment gets Domino's synthetic
 * `<html><head><body>` wrapper; a full document is injected in place and never
 * double-wrapped. Serialization normalizes the original markup, which is fine —
 * the output is the sandboxed iframe's `srcdoc`, not byte-faithful email HTML.
 */
export function normalizeEmailHtml(html: string): string {
	const doc = createDocument(html);
	doc.head.insertAdjacentHTML('afterbegin', HEAD_SHIM);
	return doc.documentElement.outerHTML;
}

function attachmentSize(attachment: PreviewAttachment): number {
	const { content } = attachment;
	if (content == null) return 0;
	if (typeof content === 'string') return content.length;
	return content instanceof Uint8Array ? content.length : content.byteLength;
}

/** Non-inline attachments as `{ filename, size }` — display-only, never served (docs/adr/0035). */
function attachmentSummaries(attachments: PreviewAttachment[]): PreviewAttachmentSummary[] {
	return attachments
		.filter((a) => a.disposition !== 'inline' || !a.contentId)
		.map((a) => ({ filename: a.filename || 'unnamed', size: attachmentSize(a) }));
}

/**
 * Build the JSON payload for the Mini App email detail screen. HTML bodies
 * get their `cid:` references inlined server-side (the client only ever sets
 * `srcdoc` from the result, still fully sandboxed — `sandbox=""` is a DOM
 * property, not a response header, so it applies identically whether set
 * from server-templated HTML or client JS, docs/adr/0035). Neither a missing
 * email nor a bodiless one omits the header metadata — `html`/`text` are
 * simply both `null`, and the client renders a placeholder note.
 */
export function buildEmailPreviewData(email: PreviewEmail | null, meta: PreviewMeta): EmailPreviewData {
	const attachments = email?.attachments ?? [];
	const html = email?.html ? normalizeEmailHtml(inlineCidImages(email.html, attachments)) : null;
	const auth = meta.authResults ? parseAuthResults(meta.authResults) : null;
	return {
		subject: meta.subject,
		from: meta.from,
		to: meta.to,
		date: meta.date,
		html,
		text: html ? null : (email?.text ?? null),
		attachments: attachmentSummaries(attachments),
		spam: meta.spam,
		auth,
	};
}
