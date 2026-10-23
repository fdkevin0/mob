import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import '../styles/app-theme.css';
import { Account } from './Account';
import { startTheme } from '../theme/theme';
import './account.css';

startTheme();
createRoot(document.getElementById('root')!).render(<Account />);
