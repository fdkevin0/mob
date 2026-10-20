import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import '../styles/base.css';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
