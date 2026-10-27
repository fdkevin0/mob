import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemePicker } from './ThemePicker';
import { saveTheme } from './theme';

afterEach(() => {
	act(() => saveTheme('system'));
	localStorage.clear();
});

describe('ThemePicker', () => {
	it('is one group of native radios, so arrow keys and a single tab stop come from the browser', () => {
		const view = render(<ThemePicker />);
		const radios = view.getAllByRole('radio') as HTMLInputElement[];
		expect(radios.map((r) => r.type)).toEqual(['radio', 'radio', 'radio']);
		expect(new Set(radios.map((r) => r.name)).size).toBe(1);
		expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(['system']);
		view.unmount();
	});

	it('keeps every picker on the page in step', () => {
		const view = render(
			<>
				<div data-testid="sidebar"><ThemePicker /></div>
				<div data-testid="drawer"><ThemePicker /></div>
			</>,
		);
		const checked = (id: string) => (view.getByTestId(id).querySelector('input:checked') as HTMLInputElement).value;
		fireEvent.click(view.getByTestId('drawer').querySelector('input[value=light]')!);
		expect(checked('drawer')).toBe('light');
		expect(checked('sidebar')).toBe('light');
		expect(localStorage.getItem('starlight-theme')).toBe('light');
		expect(document.documentElement.dataset.theme).toBe('light');
		fireEvent.click(view.getByTestId('sidebar').querySelector('input[value=dark]')!);
		expect(checked('drawer')).toBe('dark');
		view.unmount();
	});
});
