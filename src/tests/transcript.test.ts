import { describe, it, expect } from 'vitest';
import { flattenTranscript, formatDuration, toolLine, toolStartLine, truncate, type TranscriptPart } from '../features/agent/transcript';

/**
 * Tests the pure **Transcript** helpers (docs/adr/0021): `toolLine` (the one-line
 * rendering shared by chat and context), `truncate`, and `flattenTranscript` (the
 * persisted assistant-turn markdown, with the interruption marker).
 */
describe('toolLine', () => {
	it('renders status-only when there is no summary (or a blank one) but shows duration', () => {
		expect(toolLine('search', {})).toBe('✅ search');
		expect(toolLine('search', { summary: '   ' })).toBe('✅ search');
		expect(toolLine('search', { durationMs: 1200 })).toBe('✅ search · 1.2s');
	});

	it('renders a finished success with the check and the summary', () => {
		expect(toolLine('search', { summary: 'found 3' })).toBe('✅ search · found 3');
	});

	it('composes label · summary · duration on success', () => {
		expect(toolLine('web_search', { label: 'cats', summary: '5 results', durationMs: 1200 })).toBe(
			'✅ web_search · cats · 5 results · 1.2s'
		);
		expect(toolLine('fetch_url', { label: 'example.com', durationMs: 840 })).toBe('✅ fetch_url · example.com · 840ms');
	});

	it('renders the failure line, keeping the label and gaining a duration', () => {
		expect(toolLine('fetch', { error: 'timeout' })).toBe('⚠️ fetch · failed: timeout');
		expect(toolLine('fetch_url', { label: 'example.com', error: 'timeout', durationMs: 1200 })).toBe(
			'⚠️ fetch_url · example.com · failed: timeout · 1.2s'
		);
	});
});

describe('toolStartLine', () => {
	it('no label → bare wrench line', () => {
		expect(toolStartLine('web_search')).toBe('🔧 web_search');
	});

	it('label shows live with the wrench', () => {
		expect(toolStartLine('web_search', 'cats')).toBe('🔧 web_search · cats');
	});

	it('blank label is dropped', () => {
		expect(toolStartLine('run_code', '  ')).toBe('🔧 run_code');
	});
});

describe('formatDuration', () => {
	it('renders sub-second as ms', () => {
		expect(formatDuration(840)).toBe('840ms');
		expect(formatDuration(999)).toBe('999ms');
	});

	it('renders seconds-and-up as one-decimal seconds', () => {
		expect(formatDuration(1000)).toBe('1.0s');
		expect(formatDuration(1234)).toBe('1.2s');
	});
});

describe('truncate', () => {
	it('caps length and appends an ellipsis', () => {
		const out = truncate('a'.repeat(200), 100);
		expect(out.length).toBe(100);
		expect(out.endsWith('…')).toBe(true);
	});

	it('returns short text unchanged', () => {
		expect(truncate('short', 100)).toBe('short');
	});
});

describe('flattenTranscript', () => {
	it('interleaves prose and tool blockquotes', () => {
		const parts: TranscriptPart[] = [
			{ kind: 'text', text: 'Looking it up.' },
			{ kind: 'tool', name: 'search', outcome: { label: 'cats', summary: 'found 3' } },
			{ kind: 'tool', name: 'mcp_x', outcome: {} },
			{ kind: 'text', text: 'Here you go.' },
		];
		expect(flattenTranscript(parts)).toBe(
			'Looking it up.\n\n> ✅ search · cats · found 3\n\n> ✅ mcp_x\n\nHere you go.'
		);
	});

	it('omits duration in the flattened tool line (a TranscriptPart carries none)', () => {
		// Persistence keeps name + label + summary, but never the duration (docs/adr/0026).
		const parts: TranscriptPart[] = [{ kind: 'tool', name: 'web_search', outcome: { label: 'cats', summary: '5 results' } }];
		expect(flattenTranscript(parts)).toBe('> ✅ web_search · cats · 5 results');
	});

	it('appends the interruption marker when interrupted', () => {
		const parts: TranscriptPart[] = [{ kind: 'text', text: 'partial' }];
		expect(flattenTranscript(parts, { interrupted: true })).toBe('partial\n\n> ⚠️ turn interrupted');
	});

	it('flattens an empty transcript to an empty string', () => {
		expect(flattenTranscript([])).toBe('');
	});

	it('drops blank text segments', () => {
		const parts: TranscriptPart[] = [
			{ kind: 'text', text: '   ' },
			{ kind: 'tool', name: 'tool', outcome: {} },
		];
		expect(flattenTranscript(parts)).toBe('> ✅ tool');
	});
});