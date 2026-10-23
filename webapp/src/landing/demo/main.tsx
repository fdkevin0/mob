import { createRoot } from 'react-dom/client';
import '../../styles/theme.css';
import '../../styles/base.css';
import '../landing.css';
import { DemoPage } from './DemoPage';

createRoot(document.getElementById('root')!).render(<DemoPage />);
