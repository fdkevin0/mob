import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import '../styles/app-theme.css';
import { App } from './App';
import { startTheme } from '../theme/theme';
import './styles.css';

startTheme();
createRoot(document.getElementById('root')!).render(<App />);
