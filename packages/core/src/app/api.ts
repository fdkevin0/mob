// The local HTTP API's routes, as one Hono app. Its type (AppType) is what
// clients call it by: @mob/client's hc client takes the paths, request bodies
// and answers from here, so they are written once.
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { CommandRequest } from '../chat/commands';
import type { Answer } from '../chat/delegate';
import { NotFound, newID } from '../chat/sql';
import { isConversationID, TransferError, type Transfer } from '../chat/store';
import { jsonSchema } from '../chat/tools';
import { publicProvider } from '../provider/provider';
import { providerFromForm, saveProvider, type ProviderForm } from '../provider/save';
import { HTTPError, body, orFail } from './http';
import type { Server } from './server';

const pairingLifetime = 5 * 60_000;
export const chatBody = 8 << 20;
const transferBody = 64 << 20;
// titleLimit is how long a title an owner gives a conversation may be.
const titleLimit = 200;

/** bearer compares an Authorization header with the token in constant time. */
export const bearer = (header: string | null | undefined, token: string) => {
	if (!token || !header) return false;
	const want = 'Bearer ' + token;
	if (header.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= header.charCodeAt(i) ^ want.charCodeAt(i);
	return diff === 0;
};

/**
 * input reads one JSON object of at most limit bytes, refusing fields not in
 * keys when keys is given; T is the body clients send, which their hc client
 * checks. A body that fails answers 400 or 413, or falls back when given.
 */
const input = <T extends object>(limit = 256 << 10, keys?: (keyof T & string)[], fallback?: T) =>
	createMiddleware<{}, string, { in: { json: T }; out: { json: T } }>(async (c, next) => {
		let value: T;
		try { value = await body<T>(c.req.raw, limit, keys); } catch (e) {
			if (!fallback) throw e;
			value = fallback;
		}
		c.req.addValidatedData('json', value);
		await next();
	});

const days = (raw: string | undefined) => {
	// days limits the report to the last whole days, today included; 0 or none covers everything.
	const n = Number.parseInt(raw ?? '', 10);
	if (!(n > 0)) return 0;
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n + 1).getTime();
};

/** api is the app's routes; Server.fetch adds access checks around it and plugin routes after it. */
export function api(s: Server) {
	return new Hono()
		.get('/api/runtime', c => c.json({ background: !!s.options.shutdown, configError: s.options.configurationError?.() ?? '', version: s.options.version }))
		.post('/api/runtime/stop', c => {
			if (!s.options.shutdown) return c.text('service belongs to a foreground/UI process', 409);
			queueMicrotask(() => s.options.shutdown!());
			return c.json({ stopping: true }, 202);
		})
		.get('/api/memories', c => c.json(s.store.facts()))
		.post('/api/memories/:id/delete', c => c.json({ removed: s.store.forget(c.req.param('id')) }))
		.get('/api/grants', c => c.json(s.store.grants()))
		.post('/api/grants/:id/delete', c => c.json({ removed: s.store.revoke(c.req.param('id')) }))
		.get('/api/deliveries', c => c.json(s.store.deliveries()))
		.get('/api/plugins', c => c.json({
			config: s.settings.publicConfig(),
			sections: s.settings.sections.map(({ name, title, schema, secrets }) => ({ name, title, schema: jsonSchema(schema), secrets: secrets.map(x => x.name) })),
			telegramStatus: s.extensions.status('telegram'), emailStatus: s.extensions.status('email'), wechatStatus: s.extensions.status('wechat_ilink'),
		}))
		.post('/api/plugins/:plugin', async c => {
			const saved = await s.updatePlugin(c.req.param('plugin'), await body(c.req.raw)).catch(orFail(400));
			return c.json(s.settings.publicConfig(saved));
		})
		.post('/api/plugins/:plugin/test', async c => {
			return c.json(await s.testPlugin(c.req.param('plugin'), c.req.raw.signal).catch(orFail(502)) as Record<string, unknown>);
		})
		.get('/api/config', c => c.json({ defaultModel: s.providers.default(), demo: s.providers.demo }))
		.get('/api/models', async c => c.json(await s.providers.list(c.req.query('q') ?? '', c.req.raw.signal)))
		.get('/api/providers', c => {
			const f = s.providers.providers();
			return c.json({ default: f.default ?? '', providers: f.providers.map(publicProvider) });
		})
		// The web's Model provider dialog saves a provider here, as `mob provider add` does on the command line.
		.post('/api/providers', input<ProviderForm>(16 << 10, ['preset', 'url', 'protocol', 'key', 'model']), async c => {
			const form = c.req.valid('json');
			return c.json(await saveProvider(s.providers, providerFromForm(form), typeof form.model === 'string' ? form.model : undefined));
		})
		.get('/api/conversations', c => {
			// The list says which conversations are replying or waiting for a decision, so a client can mark them.
			const waiting = s.store.waiting();
			return c.json(s.store.list().map(x => ({ ...x, active: s.isActive(x.id), waiting: waiting.has(x.id) })));
		})
		.post('/api/conversations', c => c.json(s.store.create()))
		.post('/api/conversations/import', input<Transfer>(transferBody), c => {
			try { return c.json(s.store.importConversation(c.req.valid('json'))); } catch (e) { if (e instanceof TransferError) throw new HTTPError(400, e.message); throw e; }
		})
		.get('/api/conversations/:id', c => {
			const id = c.req.param('id');
			// A conversation a client named but has not said anything in yet is empty until its first message.
			if (!s.store.exists(id) && isConversationID(id)) return c.json({ messages: [], active: false, model: s.providers.default() });
			// A client showing the snapshot must not offer a decision on an approval that has expired.
			s.store.expireApprovals(id);
			return c.json({ messages: s.store.history(id).map(m => ({ id: m.id, role: m.role, parts: m.parts, metadata: m.metadata })), active: s.isActive(id), model: s.model(id) });
		})
		.get('/api/conversations/:id/context', c => {
			const id = c.req.param('id');
			// A conversation a client named but has not said anything in yet is estimated empty.
			if (!s.store.exists(id) && !isConversationID(id)) throw new NotFound();
			return c.json({ context: s.context(id, true) ?? null, usage: s.store.conversationUsage(id).get(id) });
		})
		.post('/api/conversations/:id/rename', input<{ title: string }>(4 << 10, ['title']), c => {
			const raw = c.req.valid('json').title as unknown;
			const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
			if (!title || [...title].length > titleLimit) throw new HTTPError(400, `A title has 1 to ${titleLimit} characters.`);
			const id = c.req.param('id');
			s.store.rename(id, title);
			return c.json({ id, title });
		})
		// Choosing a model is a setting of the conversation, for its later replies; it adds nothing to the transcript.
		.post('/api/conversations/:id/model', input<{ model: string }>(4 << 10, ['model']), c => {
			const model = c.req.valid('json').model as unknown;
			if (typeof model !== 'string') throw new HTTPError(400, 'model must be a provider/model reference, or empty for the default.');
			return c.json({ model: s.setModel(c.req.param('id'), model.trim()) });
		})
		.post('/api/conversations/:id/delete', c => {
			const id = c.req.param('id');
			if (s.isActive(id)) throw new HTTPError(409, 'Mob is still replying in this conversation; stop it before deleting the conversation.');
			s.store.remove(id);
			return c.json({ deleted: true });
		})
		.get('/api/usage', c => c.json(s.store.report(days(c.req.query('days')), 20)))
		// A conversation moves between Mobs, such as from the browser to a runner, as an export here and an import there.
		.get('/api/conversations/:id/export', c => {
			const id = c.req.param('id');
			if (s.isActive(id)) throw new HTTPError(409, 'Mob is still replying in this conversation; wait for it or stop it before moving the conversation.');
			try { return c.json(s.store.exportConversation(id)); } catch (e) { if (e instanceof TransferError) throw new HTTPError(409, e.message); throw e; }
		})
		.post('/api/conversations/:id/stop', c => c.json({ stopped: s.stop(c.req.param('id')) }))
		.get('/api/tasks', c => c.json(s.tasks?.tree(c.req.query('project') ?? '') ?? []))
		.post('/api/tasks/:id/stop', c => {
			try { s.tasks?.stopTask(c.req.param('id')); } catch (e) { return c.text((e as Error).message, 404); }
			return c.json({ stopped: true });
		})
		.post('/api/tasks/:id/message', input<{ text: string }>(chatBody, undefined, { text: '' }), async c => {
			const t = c.req.valid('json').text as unknown;
			if (typeof t !== 'string' || !t.trim()) return c.text('invalid message', 400);
			try { await s.tasks?.message(c.req.param('id'), t, s.revoked.signal); } catch (e) { return c.text((e as Error).message, 409); }
			return c.json({ sent: true }, 202);
		})
		.post('/api/conversations/:id/decide', input<Answer>(64 << 10, undefined, { id: '', approved: false }), async c => {
			const answer = c.req.valid('json');
			if (!answer?.id) return c.text('invalid decision', 400);
			await s.start({ id: c.req.param('id'), text: '', requestId: newID(), approval: answer, owner: true }, s.revoked.signal);
			return c.json({ started: true }, 202);
		})
		.get('/api/commands', c => c.json(s.commands.specs(c.req.query('client') ?? '')))
		.post('/api/commands/complete', input<CommandRequest>(256 << 10, ['client', 'conversationId', 'text']), async c => c.json(await s.commands.complete(c.req.valid('json'), true)))
		.post('/api/commands/run', input<CommandRequest>(256 << 10, ['client', 'conversationId', 'text']), async c => {
			return c.json(await s.commands.run(c.req.valid('json'), true, c.req.raw.signal).catch(orFail(502)));
		})
		.post('/api/chat', c => s.chat(c.req.raw))
		.get('/api/chat/:id/stream', c => s.stream(c.req.raw, c.req.param('id')))
		.get('/api/events', c => s.events(c.req.raw))
		.post('/api/pairing', c => {
			const code = newID() + newID();
			const now = Date.now();
			// Check again: a request authorized just before a rotation must not mint a code that claims the replacement token.
			if (!bearer(c.req.header('Authorization'), s.currentToken())) return c.text('unauthorized', 401);
			for (const [k, expires] of s.codes) if (now >= expires) s.codes.delete(k);
			s.codes.set(code, now + pairingLifetime);
			return c.json({ code, expiresAt: now + pairingLifetime });
		})
		.post('/api/pairing/claim', input<{ code: string }>(1 << 10, undefined, { code: '' }), c => {
			const code = c.req.valid('json').code as unknown;
			if (typeof code !== 'string' || !code) return c.text('invalid pairing request', 400);
			const expires = s.codes.get(code);
			s.codes.delete(code);
			if (!expires || Date.now() >= expires) return c.text('pairing code is invalid or expired; run mob open again', 403);
			return c.json({ token: s.currentToken() });
		})
		.post('/api/token/rotate', async c => {
			const header = c.req.header('Authorization');
			await s.rotateToken(current => bearer(header, current));
			return c.body(null, 204);
		});
}

/** AppType is the local API as clients call it. */
export type AppType = ReturnType<typeof api>;
