import { expect, test } from 'bun:test';
import { chunkLimit, chunks, fit, units } from '../src/telegram/format';

test('chunks format Markdown as Telegram HTML', () => {
	const got = chunks('# Title\n\nSome **bold**, *it*, ~~gone~~ and `a<b>` & [link](https://x.y/?a=1&b=2), [local](file:///etc).\nNext line.\n\n' +
		'- one\n- two\n  - nested\n\n3. three\n\n> quoted *text*\n\n```go\nif a < b {}\n```\n\n| Tool | 次数 |\n| --- | --- |\n| run | 2 |\n\n<div>raw</div>');
	expect(got).toHaveLength(1);
	expect(got[0]!.html).toBe('<b>Title</b>\n\nSome <b>bold</b>, <i>it</i>, <s>gone</s> and <code>a&lt;b&gt;</code> &amp; <a href="https://x.y/?a=1&amp;b=2">link</a>, local.\nNext line.\n\n' +
		'• one\n• two\n  • nested\n\n3. three\n\n<blockquote>quoted text</blockquote>\n\n<pre><code class="language-go">if a &lt; b {}</code></pre>\n\n' +
		'<pre>Tool | 次数\n-----+-----\nrun  | 2</pre>\n\n&lt;div&gt;raw&lt;/div&gt;');
	expect(got[0]!.plain).toStartWith('Title\n\nSome bold, it, gone and a<b> & link, local.');
});

test('chunks split long replies', () => {
	const code = '```\n' + 'line <x>\n'.repeat(1000) + '```';
	const got = chunks('intro\n\n' + code + '\n\n' + '😀'.repeat(3000), 4000);
	for (const c of got) expect(units(c.html)).toBeLessThanOrEqual(4000);
	expect(got[0]!.html).toStartWith('intro\n\n<pre>line &lt;x&gt;');
	expect(got[0]!.html).toEndWith('</pre>');
	let text = '';
	for (const c of got.slice(0, -2)) { expect(c.html.replace(/^intro\n\n/, '')).toStartWith('<pre>'); text += c.plain; }
	expect(text.split('line <x>').length - 1).toBe(1000);
	expect(got.at(-2)!.plain + got.at(-1)!.plain).toBe('😀'.repeat(3000));
});

test('fit keeps entities and characters whole', () => {
	expect(fit('ab&amp;c', 4)).toBe(2);
	expect(fit('😀😀', 3)).toBe(2);
	expect(fit('abc', 0)).toBe(1);
	const got = chunks('```' + 'x'.repeat(4000) + '\n' + 'code\n'.repeat(2000) + '```', 4000);
	expect(got.length).toBeGreaterThanOrEqual(3);
	for (const c of got) { expect(units(c.html)).toBeLessThanOrEqual(4000); expect(c.html).toStartWith('<pre>code'); }
});

test('escapes, entities, links and code spans', () => {
	let got = chunks('\\*literal\\* &amp; &#65; `\\* &amp;`\n\n```\n\\* &amp;\n```', chunkLimit);
	expect(got.map(c => c.html)).toEqual(['*literal* &amp; A <code>\\* &amp;amp;</code>\n\n<pre>\\* &amp;amp;</pre>']);
	expect(got[0]!.plain).toBe('*literal* & A \\* &amp;\n\n\\* &amp;');
	got = chunks('[results](https://example.com/search?a=1&amp;b=2\\&c=3 "t") ![](https://example.com/a&amp;b.png)', chunkLimit);
	expect(got.map(c => c.html)).toEqual(['<a href="https://example.com/search?a=1&amp;b=2&amp;c=3">results</a> <a href="https://example.com/a&amp;b.png">https://example.com/a&amp;b.png</a>']);
	got = chunks('run `printf\nhello` now\n\n```\nprintf\nhello\n```', chunkLimit);
	expect(got).toEqual([{ html: 'run <code>printf hello</code> now\n\n<pre>printf\nhello</pre>', plain: 'run printf hello now\n\nprintf\nhello' }]);
});
