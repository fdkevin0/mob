// The configuration of the plugins that come with Mob, as zod schemas. The
// host checks a submitted configuration against them and fills what is missing
// from their defaults; clients take their types and build forms from their
// metadata: title, description, and secret for a credential.
//
// A credential is optional text: it is never sent to clients, which instead
// read a has* flag beside it. Flags are part of the schema so the public view
// has a type, but they are recomputed on every read and never saved.
import { z } from 'zod';

/** FieldMeta is what a form needs to show one value: a credential names its flag, the field beside it saying whether one is saved. */
export type FieldMeta = { title?: string; description?: string; secret?: boolean; flag?: string };

const text = (title: string, description?: string) => z.string().default('').meta({ title, description });
const secret = (title: string, flag: string, description?: string) => z.string().optional().meta({ title, description, secret: true, flag });
const flag = () => z.boolean().optional();
const on = (title: string) => z.boolean().default(false).meta({ title });

const endpoint = (name: string, ports: string) => z.strictObject({
	host: text(`${name} host`),
	port: z.number().int().default(0).meta({ title: `${name} port`, description: ports }),
	security: z.enum(['', 'tls', 'starttls']).default('').meta({ title: `${name} security` }),
	username: text(`${name} username`),
	password: secret(`${name} password`, 'hasPassword'),
	hasPassword: flag(),
});

export const emailConfig = z.strictObject({
	enabled: on('Enable email'),
	from: text('From address'),
	imap: endpoint('IMAP', 'Usually 993 (TLS) or 143 (STARTTLS)').prefault({}),
	smtp: endpoint('SMTP', 'Usually 465 (TLS) or 587 (STARTTLS)').prefault({}),
	/** channel is whether and to whom Mob answers mail in INBOX. */
	channel: z.strictObject({
		enabled: on("Answer the owner's mail"),
		/** owner is the only address whose mail Mob answers, as the owner. */
		owner: text("Owner's address"),
		/**
		 * verifier is the authserv-id the mail provider names itself with in the
		 * Authentication-Results header it adds, such as mx.google.com. Mail is
		 * answered only when that header says the owner's domain signed it.
		 */
		verifier: text("Provider's authserv-id", 'The name your provider writes first in the Authentication-Results header of mail it receives, such as mx.google.com.'),
	}).prefault({}),
});

export const telegramConfig = z.strictObject({
	enabled: on('Enable Telegram'),
	token: secret('Bot Token', 'hasToken', 'Create a bot with @BotFather.'),
	hasToken: flag(),
	userId: z.number().int().default(0).meta({ title: 'Allowed Telegram user ID', description: 'Only private messages from this user are processed.' }),
});

export const cloudflareConfig = z.strictObject({
	enabled: on('Enable Cloudflare'),
	accountId: text('Cloudflare account ID'),
	token: secret('Cloudflare API Token', 'hasToken', 'Use a scoped token for the account containing your resources.'),
	hasToken: flag(),
	model: text('Workers AI model (ai.run)'),
	embeddingModel: text('Workers AI embedding model'),
	index: text('Vectorize index'),
	databaseId: text('D1 database ID'),
	namespaceId: text('KV namespace ID'),
	bucket: text('R2 bucket'),
	accessKey: z.string().optional().meta({ title: 'R2 S3 Access Key ID' }),
	secretKey: secret('R2 S3 Secret Access Key', 'hasSecretKey', 'Required for object access. API Token alone is used for bucket management.'),
	hasSecretKey: flag(),
});

/** The WeChat plugin signs in by QR code, so its form is its own. */
export const wechatConfig = z.strictObject({
	enabled: on('Enable WeChat iLink'),
	baseUrl: z.string().optional().meta({ title: 'iLink Base URL' }),
	botToken: secret('Bot Token', 'hasToken'),
	hasToken: flag(),
	botId: z.string().optional(),
	allowedUsers: z.array(z.string()).optional(),
});

export type EmailConfig = z.output<typeof emailConfig>;
export type Endpoint = EmailConfig['imap'];
export type EmailChannel = EmailConfig['channel'];
export type TelegramConfig = z.output<typeof telegramConfig>;
export type CloudflareConfig = z.output<typeof cloudflareConfig>;
export type WeChatILinkConfig = z.output<typeof wechatConfig>;

/** pluginConfigs are the bundled plugins' schemas by section name. */
export const pluginConfigs = { email: emailConfig, telegram: telegramConfig, cloudflare: cloudflareConfig, wechat_ilink: wechatConfig };
export type Configs = { [K in keyof typeof pluginConfigs]: z.output<(typeof pluginConfigs)[K]> };
