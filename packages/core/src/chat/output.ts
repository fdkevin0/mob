// Tool outputs as the model reads them, and saving those too large to read in place.
import { newID } from './sql';

/**
 * inlineOutput is the most of a tool's output, as JSON bytes, the model reads
 * in place: about 8000 tokens, close to what other agents allow.
 */
export const inlineOutput = 24000;
/** savedPreview is how much of a saved output the model reads in place. */
export const savedPreview = 4000;

/** Saver keeps a large tool output where the model's own tools can read it, returning the path to give the model. */
export interface Saver {
	save(conversationID: string, name: string, text: string): Promise<string>;
}

/** utf8Length is the UTF-8 byte length of s, which Go's len counts. */
export function utf8Length(s: string) {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
		else n += 3;
	}
	return n;
}

/** tokens estimates a text's prompt tokens; models.dev limits are only as exact as this needs to be. */
export const tokens = (s: string) => Math.floor(utf8Length(s) / 3) + 1;

/** encode is v as JSON. */
export const encode = (v: unknown) => JSON.stringify(v ?? null) ?? 'null';

/**
 * save keeps output in saver when it is too large to read in place, and
 * returns where; '' means it is read in place or could not be saved.
 */
export async function save(saver: Saver | undefined, conversationID: string, output: unknown): Promise<string> {
	if (!saver || utf8Length(encode(output)) <= inlineOutput) return '';
	try { return await saver.save(conversationID, newID() + '.txt', readable(output)); } catch { return ''; }
}

/**
 * modelOutput is a tool output as the model reads it: whole when small,
 * otherwise its head and tail, with where the whole is saved, if it is.
 */
export function modelOutput(output: unknown, file: string): string {
	const raw = encode(output);
	if (utf8Length(raw) <= inlineOutput) return raw;
	const text = readable(output);
	let budget = inlineOutput, note = 'The middle of this output was left out, as it is too long to read whole.';
	if (file) {
		budget = savedPreview;
		note = 'The whole output is saved at ' + file + '; read the parts you need with the sandbox tool, such as grep, sed -n or tail.';
	}
	let head = Math.floor(budget * 2 / 3), tail = Math.floor(budget / 3);
	const bytes = utf8Length(text);
	for (;;) {
		const [h, t] = ends(text, head, tail);
		const view = encode({ truncated: true, bytes, head: h, tail: t, note });
		const size = utf8Length(view);
		if (size <= budget || head + tail === 0) return view;
		head = Math.max(0, Math.min(head - 1, Math.floor(head * budget / size)));
		tail = Math.max(0, Math.min(tail - 1, Math.floor(tail * budget / size)));
	}
}

/**
 * readable is output as text to read or search: a string as it is, an
 * object's fields in name order, long or multi-line strings as their own
 * sections, anything else as indented JSON.
 */
export function readable(output: unknown): string {
	if (typeof output === 'string') return output;
	const value = JSON.parse(encode(output));
	if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value, null, 2);
	let b = '';
	for (const key of Object.keys(value).sort()) {
		const s = value[key];
		if (typeof s === 'string' && (s.includes('\n') || utf8Length(s) > 200)) {
			b += '--- ' + key + ' ---\n' + s + (s.endsWith('\n') ? '' : '\n');
			continue;
		}
		b += key + ': ' + encode(s) + '\n';
	}
	return b;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();

/** ends is up to head bytes from the start of s and tail bytes from its end, cut at character boundaries. */
export function ends(s: string, head: number, tail: number): [string, string] {
	const b = encoder.encode(s);
	if (b.length <= head + tail) return [s, ''];
	const start = (i: number) => (b[i] & 0xc0) !== 0x80;
	while (head > 0 && !start(head)) head--;
	let from = b.length - tail;
	while (from < b.length && !start(from)) from++;
	return [decoder.decode(b.subarray(0, head)), decoder.decode(b.subarray(from))];
}
