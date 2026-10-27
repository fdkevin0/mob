import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../tailwind.css';
import '@mob/ui/base.css';
import '../landing.css';
import { DemoPage } from './DemoPage';
import { startTheme } from '@mob/ui/theme';

startTheme();
// The first render commits before the script ends, and the script blocks
// rendering (blocking="render" in the HTML), so a view transition into this
// page captures the header rather than an empty root.
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<DemoPage />));
