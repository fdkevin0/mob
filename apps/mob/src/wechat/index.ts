// The WeChat iLink plugin; it signs in by QR code in the web UI, so the web UI's form for it is its own.
import { body, CommandError, wechatConfig, type Plugin, type Section, type Server } from '@mob/core';
import { hostPlugins } from '../local';
import { Client, test, validate, type Config } from './client';
import { Service } from './service';

export const section: Section<Config> = {
	name: 'wechat_ilink', title: 'WeChat iLink', label: 'WeChat iLink',
	schema: wechatConfig, secrets: [{ name: 'botToken', flag: 'hasToken' }], validate,
	enabled: c => c.enabled,
	test: c => test(c),
};

function plugin(server: Server): Plugin {
	const config = () => server.settings.config().wechat_ilink as Config;
	const service = () => new Service(server.options.store, server);
	return {
		name: 'wechat_ilink', section,
		routes: [
			{ method: 'POST', path: 'qrcode', handle: req => new Client(config()).qrCode(req.signal) },
			{ method: 'GET', path: 'qrcode/status', handle: req => {
				const qrcode = new URL(req.url).searchParams.get('qrcode');
				if (!qrcode) throw new CommandError(400, 'missing qrcode parameter');
				return new Client(config()).qrCodeStatus(qrcode, req.signal);
			} },
			// The web UI sends a message as a WeChat user would.
			{ method: 'POST', path: 'message', handle: async req => {
				const c = config();
				if (!c.enabled) throw new CommandError(409, 'wechat_ilink plugin disabled');
				const p = await body<{ senderId?: string; contextToken?: string; text?: string }>(req);
				return { reply: await service().process(c, p.senderId ?? '', p.text ?? '', req.signal) };
			} },
		],
		background: { name: 'wechat_ilink', start: () => {
			const c = config();
			if (!c.enabled || !c.botToken) return undefined;
			const s = service();
			return (signal, status) => s.loop(new Client(c), signal, status);
		} },
	};
}

hostPlugins.push((_, server) => [plugin(server)]);
