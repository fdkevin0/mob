import type { LanguageModel } from 'ai';
import { QueueMessage } from '../features/queue/queue';
import type { ConversationAgent } from '../features/agent/conversation-agent';
import type { Sandbox } from '@cloudflare/sandbox';

export interface Env {
	/** One agent per Telegram chat, addressed by String(chatId). */
	ConversationAgent: DurableObjectNamespace<ConversationAgent>;

	/** Chat-keyed container for code and shell execution. */
	Sandbox: DurableObjectNamespace<Sandbox>;

	STATE: KVNamespace;
	FEEDS: KVNamespace;
	QUEUE: Queue<QueueMessage>;
	R2_DOWNLOADS: R2Bucket;
	EMAIL_BUCKET: R2Bucket;
	/** Private bookmark originals; absent until provisioned. */
	BOOKMARK_BUCKET?: R2Bucket;
	BOOKMARK_SEARCH?: AiSearchInstance;
	/** Deferred replies; requires a sending-enabled From domain and an allowed recipient. */
	EMAIL?: SendEmail;
	DB: D1Database;

	/** Seeds the user directory. Authorize through Principal, not this value. */
	TELEGRAM_ADMIN_ID: number;
	TELEGRAM_API_TOKEN: string;

	IPPLUS360_TOKEN: string;

	/** Embeddings and document conversion; LLM calls use DeepSeek. */
	AI: Ai<ModelList>;

	/** Broadcast destination for the Nikon watcher. */
	NIKON_CHANNEL_ID: number;

	/** 1024-dimension cosine index for bge-m3, with a chatId metadata index for isolation. */
	MEMORIES: VectorizeIndex;

	/** Default IANA timezone for the datetime tool; UTC when unset. */
	BOT_TIMEZONE?: string;

	/** Sandbox budget per user in each chat per UTC day, shared by code and shell. 0 disables it. */
	SANDBOX_DAILY_LIMIT_SECONDS?: number;

	/** Local .env value or production Worker secret. */
	DEEPSEEK_API_KEY: string;

	/** Registers web_search when configured. */
	TAVILY_API_KEY?: string;

	/** Test-injected model; production resolves DeepSeek. */
	CHAT_MODEL?: LanguageModel;

	/** Public Mini App origin, also used for email-preview deep links. */
	MINIAPP_BASE_URL?: string;

	/** Settings Mini App build served under /miniapp/. */
	ASSETS: Fetcher;

	/** Deploy ID for command sync; absent bindings skip automatic sync. */
	CF_VERSION_METADATA?: WorkerVersionMetadata;
}

type ModelList = {
	'@cf/qwen/qwq-32b': BaseAiTextGeneration;
	'@cf/google/gemma-4-26b-a4b-it': BaseAiTextGeneration;
};
