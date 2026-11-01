// The Telegram plugin: Mob answers its owner's private messages to a bot.
import { telegramConfig, type Plugin, type Section } from '@mob/core';
import { hostPlugins } from '../local';
import { Bot, validate, type Config } from './api';
import { Service } from './service';

export const section: Section<Config> = {
	name: 'telegram', title: 'Telegram Bot API', label: 'Telegram',
	schema: telegramConfig, secrets: [{ name: 'token', flag: 'hasToken' }], validate,
	enabled: c => c.enabled,
	test: (c, signal) => new Bot(c).test(signal),
};

hostPlugins.push((_, server): Plugin[] => [{
	name: 'telegram',
	section,
	background: { name: 'telegram', start: () => {
		const c = server.settings.config().telegram as Config;
		if (!c.enabled) return undefined;
		const service = new Service(server.options.store, server);
		return (signal, status) => service.loop(new Bot(c), signal, status);
	} },
}]);
