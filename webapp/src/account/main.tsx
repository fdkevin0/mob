import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import { Account } from './Account';
import './account.css';

createRoot(document.getElementById('root')!).render(<Account />);
