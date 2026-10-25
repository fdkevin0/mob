import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import { Landing } from './Landing';
import { startTheme } from '../theme/theme';
import './landing.css';

startTheme();
// The first render commits before the script ends, and the script blocks
// rendering (blocking="render" in the HTML), so a view transition into this
// page captures the header rather than an empty root.
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<Landing />));
