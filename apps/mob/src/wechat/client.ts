// The official WeChat iLink bot API.
export const defaultBaseURL = 'https://ilinkai.weixin.qq.com';

export type Config = { enabled: boolean; baseUrl?: string; botToken?: string; hasToken?: boolean; botId?: string; allowedUsers?: string[] };

export const defaults = (): Config => ({ enabled: false, baseUrl: '', botToken: '', botId: '', allowedUsers: [] });

/** endpoint is the effective API base URL. */
export const endpoint = (c: Config) => (c.baseUrl ?? '').trim() ? c.baseUrl!.trim().replace(/\/+$/, '') : defaultBaseURL;

export function validate(c: Config) {
	if (!c.enabled || !c.baseUrl) return;
	let u: URL | undefined;
	try { u = new URL(c.baseUrl); } catch { /* refused below */ }
	if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error('WeChat iLink: baseUrl must be a valid HTTP or HTTPS URL');
}

export const publicView = (c: Config): Config => { const p: Config = { ...c, hasToken: !!c.botToken }; delete p.botToken; return p; };

export async function test(c: Config) {
	validate(c);
	return { channel: 'wechat-ilink', baseUrl: endpoint(c), hasToken: !!c.botToken || !!c.hasToken, botId: c.botId ?? '', allowedUsers: c.allowedUsers?.length ?? 0, status: 'ready' };
}

/** isOwner reports whether the sender is the first allowed user, who owns this Mob; with no allow list nobody is. */
export const isOwner = (c: Config, user: string) => !!c.allowedUsers?.length && c.allowedUsers[0] === user;
/** allowed reports whether the sender may use the bot; with no allow list everyone may. */
export const allowed = (c: Config, user: string) => !c.allowedUsers?.length || c.allowedUsers.some(u => u.trim() === user);

export type Inbound = { msg_id?: string; from_user_id?: string; to_user_id?: string; message_type?: number; context_token?: string; item_list?: { type: number; text_item?: { text: string } }[] };
export type Updates = { ret: number; msgs?: Inbound[]; get_updates_buf?: string; longpolling_timeout_ms?: number };

const baseInfo = { channel_version: '2.4.8', bot_agent: 'Mob' };

export class Client {
	constructor(readonly config: Config, readonly fetcher: typeof fetch = fetch) {}

	private headers() {
		const h: Record<string, string> = { AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': '10001', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '2.4.8', 'Content-Type': 'application/json' };
		if (this.config.botToken) h.Authorization = 'Bearer ' + this.config.botToken;
		return h;
	}

	private request(method: string, path: string, body?: unknown, signal?: AbortSignal) {
		return this.fetcher(endpoint(this.config) + path, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([...signal ? [signal] : [], AbortSignal.timeout(45_000)]) });
	}

	/** qrCode requests a login QR code. */
	async qrCode(signal?: AbortSignal): Promise<{ qrcode: string; qrcode_img_content: string }> {
		let res: Response;
		try { res = await this.request('POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, signal); } catch (err) { throw new Error('iLink QRCode request failed: ' + (err as Error).message); }
		if (res.status !== 200) throw new Error(`iLink QRCode status ${res.status}: ${await res.text()}`);
		const r = await res.json() as { qrcode?: string; qrcode_img_content?: string };
		return { qrcode: r.qrcode ?? '', qrcode_img_content: r.qrcode_img_content ?? '' };
	}

	/** qrCodeStatus checks whether the QR code was scanned, and carries the bot token once confirmed. */
	async qrCodeStatus(qrcode: string, signal?: AbortSignal) {
		const res = await this.request('GET', '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), undefined, signal);
		const r = await res.json() as Record<string, string | undefined>;
		return { status: r.status ?? '', bot_token: r.bot_token ?? '', ilink_bot_id: r.ilink_bot_id ?? '', baseurl: r.baseurl ?? '', ilink_user_id: r.ilink_user_id ?? '' };
	}

	/** updates long-polls for new messages. */
	async updates(cursor: string, signal?: AbortSignal): Promise<Updates> {
		const res = await this.request('POST', '/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: baseInfo }, signal);
		if (res.status !== 200) throw new Error(`iLink getupdates error ${res.status}: ${await res.text()}`);
		const r = await res.json() as Updates;
		if (r.ret !== 0) throw new Error(`iLink getupdates failed: ret ${r.ret}`);
		return r;
	}

	/** send delivers a text message back to the WeChat user. */
	async send(to: string, contextToken: string, text: string, signal?: AbortSignal) {
		const res = await this.request('POST', '/ilink/bot/sendmessage', {
			msg: { from_user_id: this.config.botId ?? '', to_user_id: to, client_id: `mob-${Date.now()}${Math.floor(Math.random() * 1e6)}`, message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] },
			base_info: baseInfo,
		}, signal);
		if (res.status !== 200) throw new Error(`iLink sendmessage error ${res.status}: ${await res.text()}`);
		const r = await res.json() as { ret?: number };
		if (r.ret !== 0) throw new Error(`iLink sendmessage failed: ret ${r.ret}`);
	}

	/** typing tells the user the bot is writing a response. */
	async typing(to: string, contextToken: string, signal?: AbortSignal) {
		await this.request('POST', '/ilink/bot/sendtyping', { to_user_id: to, context_token: contextToken }, signal);
	}
}
