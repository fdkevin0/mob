import { createRoot } from 'react-dom/client';
import '../tailwind.css';
import '@mob/ui/base.css';
import '@mob/app/styles.css';
import './prototype.css';
import { startTheme } from '@mob/ui/theme';
import { PlanPrototype } from './PlanPrototype';

startTheme();
createRoot(document.getElementById('root')!).render(<PlanPrototype search={location.search} />);
