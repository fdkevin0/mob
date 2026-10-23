// Markdown as the HTML subset Telegram shows, in messages that fit its limit.
import { Lexer, type Token, type Tokens } from 'marked';

/** chunkLimit is the most UTF-16 code units of HTML in one message, below Telegram's 4096 for the text it parses out of it. */
export const chunkLimit = 4000;

/** Chunk is one message: HTML in the subset Telegram accepts, and the same text plain, to send if Telegram rejects the HTML. */
export type Chunk = { html: string; plain: string };

export const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&#34;').replaceAll("'", '&#39;');

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', middot: '·', bull: '•', deg: '°', euro: '€' };

/** unescape resolves HTML entities. */
export function unescape(s: string) {
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
		}
		return named[e] ?? all;
	});
}

/** units is the length of s in UTF-16 code units, as Telegram counts. */
export const units = (s: string) => s.length;

/** plain is the text of Telegram HTML. */
export const plain = (s: string) => unescape(s.replace(/<[^>]*>/g, ''));

/**
 * chunks renders Markdown as Telegram HTML in messages that each fit the
 * limit, splitting between blocks, and within a block only when it alone is
 * too long.
 */
export function chunks(markdown: string, limit = chunkLimit): Chunk[] {
	const list: Chunk[] = [];
	let current = '';
	const flush = () => {
		const s = current.trim();
		if (s) list.push({ html: s, plain: plain(s) });
		current = '';
	};
	for (const token of new Lexer({ gfm: true }).lex(markdown)) {
		const block = renderBlock(token).trim();
		if (!block) continue;
		for (const part of split(token, block, limit)) {
			if (current && units(current) + 2 + units(part) > limit) flush();
			if (current) current += '\n\n';
			current += part;
		}
	}
	flush();
	return list;
}

/** split is block in pieces that fit the limit: a code block becomes several code blocks, anything else plain text. */
function split(token: Token, block: string, limit: number): string[] {
	if (units(block) <= limit) return [block];
	let open = '', end = '', text: string;
	if (token.type === 'code') {
		const lang = (token as Tokens.Code).lang;
		[open, end] = lang ? [`<pre><code class="language-${escape(lang)}">`, '</code></pre>'] : ['<pre>', '</pre>'];
		text = escape((token as Tokens.Code).text);
	} else text = escape(plain(block));
	const lines = text.split(/(?<=\n)/);
	let room = limit - units(open) - units(end);
	if (room < limit / 2) {
		// A language tag that long is not worth the room.
		[open, end] = ['<pre>', '</pre>'];
		room = limit - units(open) - units(end);
	}
	const parts: string[] = [];
	let b = '';
	for (let line of lines) {
		while (units(line) > room) {
			const cut = fit(line, room);
			if (b) { parts.push(open + b + end); b = ''; }
			parts.push(open + line.slice(0, cut) + end);
			line = line.slice(cut);
		}
		if (units(b) + units(line) > room) { parts.push(open + b + end); b = ''; }
		b += line;
	}
	if (b) parts.push(open + b + end);
	return parts;
}

/** fit is how many code units of s fit in room without cutting a character or an HTML entity. */
export function fit(s: string, room: number) {
	let n = 0;
	for (const ch of s) {
		if (n + ch.length > room) break;
		n += ch.length;
	}
	const amp = s.lastIndexOf('&', n - 1);
	if (amp > 0 && !s.slice(amp, n).includes(';')) n = amp;
	// Always take a character, so that splitting ends.
	if (n === 0 && s) n = [...s][0]!.length;
	return n;
}

/**
 * renderBlock is a block in Telegram HTML, which has no headings, lists or
 * tables: headings become bold lines, list items bulleted lines and tables
 * aligned preformatted text.
 */
function renderBlock(t: Token): string {
	switch (t.type) {
		case 'space': case 'def': return '';
		case 'heading': return '<b>' + inline((t as Tokens.Heading).tokens) + '</b>';
		case 'paragraph': return inline((t as Tokens.Paragraph).tokens);
		case 'text': return (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens!) : escape(unescape((t as Tokens.Text).text));
		case 'code': {
			const c = t as Tokens.Code;
			return c.lang ? `<pre><code class="language-${escape(c.lang)}">${escape(c.text)}</code></pre>` : `<pre>${escape(c.text)}</pre>`;
		}
		// Telegram does not nest blocks in a quote.
		case 'blockquote': return '<blockquote>' + escape((t as Tokens.Blockquote).tokens.map(c => plain(renderBlock(c))).filter(Boolean).join('\n\n')) + '</blockquote>';
		case 'list': return list(t as Tokens.List, '');
		case 'hr': return '———';
		case 'html': return escape((t as Tokens.HTML).text.replace(/\n+$/, ''));
		case 'table': return table(t as Tokens.Table);
	}
	return escape((t as { text?: string }).text ?? '');
}

function list(l: Tokens.List, indent: string): string {
	const lines: string[] = [];
	let number = typeof l.start === 'number' ? l.start : 1;
	for (const item of l.items) {
		const marker = l.ordered ? `${number++}. ` : '• ';
		let first = true;
		for (const c of item.tokens) {
			if (c.type === 'list') { lines.push(list(c as Tokens.List, indent + '  ')); continue; }
			if (c.type === 'space') continue;
			const body = renderBlock(c);
			lines.push(first ? indent + marker + body : indent + '  ' + body);
			first = false;
		}
		if (first) lines.push(indent + marker);
	}
	return lines.join('\n');
}

/** table is a table as preformatted text with its columns aligned. */
function table(t: Tokens.Table): string {
	const rows = [t.header, ...t.rows].map(row => row.map(cell => plain(inline(cell.tokens))));
	const widths: number[] = [];
	for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, Bun.stringWidth(cell)); });
	let b = '';
	rows.forEach((row, r) => {
		b += row.map((cell, i) => i < row.length - 1 ? cell + ' '.repeat(widths[i]! - Bun.stringWidth(cell)) : cell).join(' | ') + '\n';
		if (r === 0 && rows.length > 1) b += widths.map(w => '-'.repeat(w)).join('-+-') + '\n';
	});
	return '<pre>' + escape(b.replace(/\n$/, '')) + '</pre>';
}

/** inline is the HTML of inline tokens. */
function inline(tokens: Token[]): string {
	return tokens.map(t => {
		switch (t.type) {
			case 'text': return (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens!) : escape(unescape((t as Tokens.Text).text));
			case 'escape': return escape((t as Tokens.Escape).text);
			// A code span reads its line endings as spaces.
			case 'codespan': return '<code>' + escape((t as Tokens.Codespan).text.replace(/\r\n|\n|\r/g, ' ')) + '</code>';
			case 'em': return '<i>' + inline((t as Tokens.Em).tokens) + '</i>';
			case 'strong': return '<b>' + inline((t as Tokens.Strong).tokens) + '</b>';
			case 'del': return '<s>' + inline((t as Tokens.Del).tokens) + '</s>';
			case 'br': return '\n';
			case 'link': {
				const l = t as Tokens.Link;
				// An email address autolink is shown as text.
				if (l.href.startsWith('mailto:') && l.text === l.href.slice(7)) return escape(l.text);
				return anchor(destination(l.href), inline(l.tokens));
			}
			case 'image': {
				const i = t as Tokens.Image;
				return anchor(destination(i.href), i.text ? escape(unescape(i.text)) : escape(destination(i.href)));
			}
			case 'html': return escape((t as Tokens.HTML).text);
		}
		return escape(unescape((t as { text?: string }).text ?? ''));
	}).join('');
}

/** destination is a link destination with entities resolved and the URL percent-encoded. */
function destination(raw: string) {
	return unescape(raw).replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, c => encodeURIComponent(c));
}

/** anchor links label to url when Telegram would accept the link, and is the label alone otherwise. */
function anchor(url: string, label: string) {
	const lower = url.toLowerCase();
	if (!lower.startsWith('http://') && !lower.startsWith('https://') && !lower.startsWith('tg://')) return label;
	return `<a href="${escape(url)}">${label}</a>`;
}
