import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource/geist-mono/400.css';
import '@fontsource/silkscreen/400.css';
import { Landing } from './Landing';
import './landing.css';

createRoot(document.getElementById('root')!).render(<Landing />);
