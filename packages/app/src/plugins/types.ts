export type { Endpoint, EmailChannel, EmailConfig, TelegramConfig, CloudflareConfig, WeChatILinkConfig, Configs } from '../contracts';
export type Summary = { uid: number; validity: number; subject: string; from: string; date: string };
export type Mail = Summary & { text: string; attachments: string[] };
export type Draft = { to: string; subject: string; text: string };
