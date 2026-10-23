// The Telegram plugin: Mob answers its owner's private messages to a bot.
import type { Plugin, Section } from '@mob/core';
import { hostPlugins } from '../local';
import { Bot, defaults, publicView, validate, type Config } from './api';
import { Service } from './service';

export const section: Section<Config> = {
	name: 'telegram', title: 'Telegram Bot API', label: 'Telegram',
	fields: [
		{ path: 'enabled', label: 'Enable Telegram (true/false)', kind: 'bool' },
		{ path: 'token', label: 'Bot Token (blank keeps saved token)', kind: 'secret' },
		{ path: 'userId', label: 'Allowed Telegram user ID (private messages only)', kind: 'int' },
	],
	secrets: [{ name: 'token' }],
	defaults, validate, publicView,
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
