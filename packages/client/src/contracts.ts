// The wire contract between Mob and its clients: the host serves these shapes and every client reads them.
export type * from '@mob/core/contracts';
import type { Fact, Grant, Schedule } from '@mob/core/contracts';
import type { Answer, Rpc } from './api';

// Answers of the typed API are taken from its routes.
export type Config = Answer<Awaited<ReturnType<Rpc['config']['$get']>>>;
export type ConversationContext = Answer<Awaited<ReturnType<Rpc['conversations'][':id']['context']['$get']>>>;

// Management views use structured data; slash command Markdown is only presentation.
export type Memory = Fact;
export type RememberedApproval = Grant;
export type ScheduledPrompt = Schedule;
