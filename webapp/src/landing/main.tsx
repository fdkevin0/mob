import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import { Landing } from './Landing';
import './landing.css';

createRoot(document.getElementById('root')!).render(<Landing />);
