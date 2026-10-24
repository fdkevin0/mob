import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { code } from '@streamdown/code';
import { JsonResponse, MessageResponse } from '../components/ai-elements/message';

const tokens = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('code span[style]')]
	.filter((span) => span.style.getPropertyValue('--shiki-dark'));

const fence = (language: string, text: string) => '```' + language + '\n' + text + '\n```';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('highlights code with both themes and copies the original source', async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal('navigator', { clipboard: { writeText } });
	const source = 'const greeting = "你好";';
	const view = render(<MessageResponse>{fence('ts', source)}</MessageResponse>);
	// The first render lazily loads the highlighter, language grammar and themes.
	await waitFor(() => expect(tokens(view.container).length).toBeGreaterThan(1), { timeout: 3000 });
	expect(new Set(tokens(view.container).map((span) => span.style.getPropertyValue('--sdm-c'))).size).toBeGreaterThan(1);
	fireEvent.click(view.getByRole('button', { name: /copy/i }));
	await waitFor(() => expect(writeText).toHaveBeenCalled());
	expect(writeText.mock.calls[0][0].trimEnd()).toBe(source);
});

it('updates an open fence while streaming and keeps only the latest code', async () => {
	const view = render(<MessageResponse isAnimating>{'```typescript\nconst n = 1;'}</MessageResponse>);
	await waitFor(() => expect(tokens(view.container).length).toBeGreaterThan(1));
	view.rerender(<MessageResponse isAnimating>{'```typescript\nconst n = 12;\nconsole.log(n);'}</MessageResponse>);
	await waitFor(() => expect(view.container.querySelector('code')?.textContent).toContain('const n = 12;'));
	view.rerender(<MessageResponse isAnimating={false}>{fence('typescript', 'const n = 12;\nconsole.log(n);')}</MessageResponse>);
	await waitFor(() => expect(view.container.querySelector('code')?.textContent).toContain('console.log(n);'));
	expect(view.container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(1);
	expect((view.getByRole('button', { name: /copy/i }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(['', 'unsupported-mob-language'])('preserves unknown or missing language %j as text', async (language) => {
	const source = '<script>alert("test")</script>';
	const view = render(<MessageResponse>{fence(language, source)}</MessageResponse>);
	await waitFor(() => expect(view.container.querySelector('code')?.textContent).toContain(source));
	expect(view.container.querySelector('script')).toBeNull();
});

it('renders tool data as highlighted JSON without interpreting embedded Markdown or HTML', async () => {
	const value = { output: '\n```\n# Heading\n<img src=x onerror=alert(1)>\n```', ok: true };
	const view = render(<JsonResponse value={value} />);
	await waitFor(() => expect(tokens(view.container).length).toBeGreaterThan(1));
	const lines = [...view.container.querySelectorAll('code > span')].map((line) => line.textContent);
	expect(lines.join('\n')).toBe(JSON.stringify(value, null, 2));
	expect(view.container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(1);
	expect(view.container.querySelector('img, h1, script')).toBeNull();
});

it('keeps absent tool arguments empty and renders null as JSON', async () => {
	const view = render(<JsonResponse value={undefined} />);
	expect(view.container.textContent).toBe('');
	view.rerender(<JsonResponse value={null} />);
	await waitFor(() => expect(view.container.querySelector('code')?.textContent?.trim()).toBe('null'));
});


it.each([
	['long text', { output: '<img src=x onerror=alert(1)>'.repeat(1000) }],
	['many short lines', Array.from({ length: 300 }, () => 0)],
	['large result', Array.from({ length: 10_000 }, (_, id) => ({ id, name: 'result-' + id, ok: true }))],
])('shows complete %s as plain JSON without highlighting, even when collapsed', async (_, value) => {
	const highlight = vi.spyOn(code, 'highlight');
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal('navigator', { clipboard: { writeText } });
	const json = JSON.stringify(value, null, 2);
	const view = render(<details><summary>Tool</summary><JsonResponse value={value} /></details>);
	const pre = view.getByLabelText('Tool JSON');
	expect(pre.textContent).toBe(json);
	expect(pre.tagName).toBe('PRE');
	expect(pre.tabIndex).toBe(0);
	expect(pre.children).toHaveLength(0);
	expect(view.container.querySelector('img, script, [data-streamdown="code-block"]')).toBeNull();
	fireEvent.click(view.getByText('Tool'));
	fireEvent.click(view.getByRole('button', { name: /copy/i }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(json));
	expect(highlight).not.toHaveBeenCalled();
});
