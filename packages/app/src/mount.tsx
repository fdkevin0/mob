import { createRoot } from 'react-dom/client';
import '@mob/ui/base.css';
import { App } from './App';
import { startTheme } from '@mob/ui/theme';
import './styles.css';

// Starts the workspace in #root. The page brings the Tailwind entry first:
// app.css when mob serves it (main.tsx), the site's own in apps/web, so the
// site's pages share one stylesheet.
export function mount() {
	startTheme();
	createRoot(document.getElementById('root')!).render(<App />);
}
