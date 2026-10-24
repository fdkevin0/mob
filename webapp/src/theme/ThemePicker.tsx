import { useId, type ReactNode } from 'react';
import { themes, useTheme, type Theme } from './theme';

const labels: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

const icons: Record<Theme, ReactNode> = {
	system: (
		<>
			<rect x="3" y="4" width="18" height="12" rx="2" />
			<path d="M8 20h8M12 16v4" />
		</>
	),
	light: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</>
	),
	dark: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
};

// Three small radio buttons that pick the colour scheme: follow the system, light or dark.
// They are native radios, so arrow keys move the choice and the group is one tab stop.
export function ThemePicker({ className }: { className?: string }) {
	const [theme, setTheme] = useTheme();
	const name = useId();
	return (
		<div role="radiogroup" aria-label="Theme" className={className ? `theme-picker ${className}` : 'theme-picker'}>
			{themes.map((t) => (
				<label key={t} title={labels[t]}>
					<input type="radio" name={name} value={t} aria-label={labels[t]} checked={theme === t} onChange={() => setTheme(t)} />
					<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						{icons[t]}
					</svg>
				</label>
			))}
		</div>
	);
}
