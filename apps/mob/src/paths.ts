// Where Mob keeps its files: the XDG base directories on Linux, and their
// counterparts on macOS and Windows.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const home = homedir();
const env = (name: string) => { const v = process.env[name]; return v && isAbsolute(v) ? v : ''; };
const mac = process.platform === 'darwin', windows = process.platform === 'win32';
const local = () => process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
const support = join(home, 'Library', 'Application Support');

export const configHome = () => env('XDG_CONFIG_HOME') || (windows ? local() : mac ? support : join(home, '.config'));
export const dataHome = () => env('XDG_DATA_HOME') || (windows ? local() : mac ? support : join(home, '.local', 'share'));
export const stateHome = () => env('XDG_STATE_HOME') || (windows ? local() : mac ? support : join(home, '.local', 'state'));
export const cacheHome = () => env('XDG_CACHE_HOME') || (windows ? join(local(), 'cache') : mac ? join(home, 'Library', 'Caches') : join(home, '.cache'));
