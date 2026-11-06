// The host's plugins, registered in the order clients list them.
import { agentsPlugin } from './agents';
import { cloudflarePlugin } from './cloudflare';
import { validators } from './config';
import { emailPlugin } from './email';
import { githubHostPlugin } from './github';
import { hostPlugins } from './local';
import { mcpPlugin } from './mcp';
import { runnerPlugin } from './runner';
import { sandboxPlugin } from './sandbox';
import { schedulesPlugin } from './schedules';
import { skillsPlugin } from './skills';
import { telegramPlugin } from './telegram';
import { wechatPlugin } from './wechat';

const all = [
	agentsPlugin,
	emailPlugin,
	telegramPlugin,
	cloudflarePlugin,
	wechatPlugin,
	mcpPlugin,
	sandboxPlugin,
	skillsPlugin,
	schedulesPlugin,
	runnerPlugin,
	githubHostPlugin,
];

for (const p of all) {
	hostPlugins.push(p);
	if (p.validate) validators.push(p.validate);
}
