import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import { Landing } from './Landing';
import { startTheme } from '../theme/theme';
import './landing.css';

startTheme();
createRoot(document.getElementById('root')!).render(<Landing />);
