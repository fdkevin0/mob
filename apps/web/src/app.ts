// /app on the site: the workspace from @mob/app, built in public mode so it
// can also run Mob in the browser, with the site's stylesheet.
import './tailwind.css';
import { mount } from '@mob/app/mount';

mount();
