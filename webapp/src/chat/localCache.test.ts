import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cacheScope, readDraft, writeDraft, forgetSnapshot, forget, keptConversations, readList, readSnapshot, resume, setKeepsMessages, writeList, writeSnapshot } from './localCache';

const local = cacheScope({ url: 'http://127.0.0.1:8787', token: 't' });
const runner = cacheScope({ url: 'https://mob.example/api/runners/r1', token: '', runner: { id: 'r1', key: 'k' } });
const snapshot = (text: string) => ({
	messages: [{ id: text, role: 'assistant' as const, parts: [{ type: 'text' as const, text }] }],
	active: false,
	model: 'demo/echo',
});

beforeEach(() => {
	resume(local);
	resume(runner);
});

afterEach(async () => {
	await setKeepsMessages(false);
	await forget(local);
	await forget(runner);
});

it('keeps only titles unless this device keeps messages', async () => {
	await writeList(local, [{ id: 'one', title: 'First', updatedAt: 1, extra: 'not kept' } as never]);
	expect(await readList(local)).toEqual([{ id: 'one', title: 'First', updatedAt: 1 }]);
	await writeSnapshot(local, 'one', snapshot('hello'));
	expect(await readSnapshot(local, 'one')).toBeUndefined();
	await setKeepsMessages(true);
	await writeSnapshot(local, 'one', snapshot('hello'));
	expect(await readSnapshot(local, 'one')).toEqual(snapshot('hello'));
	// Turning it off forgets the messages, not the titles.
	await setKeepsMessages(false);
	await setKeepsMessages(true);
	expect(await readSnapshot(local, 'one')).toBeUndefined();
	expect(await readList(local)).toHaveLength(1);
});

it('keeps each Mob apart, forgets one alone, and keeps only the most recent conversations', async () => {
	await setKeepsMessages(true);
	await writeList(local, [{ id: 'one', title: 'Local', updatedAt: 1 }]);
	await writeList(runner, [{ id: 'one', title: 'Runner', updatedAt: 1 }]);
	for (let i = 0; i <= keptConversations; i++) await writeSnapshot(runner, `c${i}`, snapshot(`m${i}`));
	expect(await readSnapshot(runner, 'c0')).toBeUndefined();
	expect(await readSnapshot(runner, `c${keptConversations}`)).toBeDefined();
	await forget(runner);
	expect(await readList(runner)).toBeUndefined();
	expect((await readList(local))?.[0].title).toBe('Local');
});


it('isolates drafts by connection and conversation and removes cleared or forgotten drafts', async () => {
	await setKeepsMessages(true);
	await writeDraft(local, 'one', 'Local draft');
	await writeDraft(local, 'two', 'Other conversation');
	await writeDraft(runner, 'one', 'Remote draft');
	expect(await readDraft(local, 'one')).toBe('Local draft');
	expect(await readDraft(local, 'two')).toBe('Other conversation');
	expect(await readDraft(runner, 'one')).toBe('Remote draft');
	await writeDraft(local, 'one', '');
	expect(await readDraft(local, 'one')).toBeUndefined();
	await forget(runner);
	await writeDraft(runner, 'one', 'Late write');
	resume(runner);
	expect(await readDraft(runner, 'one')).toBeUndefined();
});

it('keeps drafts only with permission and clears saved drafts when permission is removed', async () => {
	await setKeepsMessages(false);
	await writeDraft(local, 'one', 'Private');
	expect(await readDraft(local, 'one')).toBeUndefined();
	await setKeepsMessages(true);
	await writeDraft(local, 'one', 'Saved');
	await setKeepsMessages(false);
	await setKeepsMessages(true);
	expect(await readDraft(local, 'one')).toBeUndefined();
});

it('keeps browser-runner drafts locally without enabling remote message caching', async () => {
	resume('browser');
	await setKeepsMessages(false);
	await writeDraft('browser', 'one', 'Browser draft');
	expect(await readDraft('browser', 'one')).toBe('Browser draft');
	await forget('browser');
	resume('browser');
	expect(await readDraft('browser', 'one')).toBeUndefined();
});


it('removes a deleted conversation draft without clearing another conversation', async () => {
	await setKeepsMessages(true);
	await writeDraft(local, 'one', 'Deleted draft');
	await writeDraft(local, 'two', 'Retained draft');
	await forgetSnapshot(local, 'one');
	expect(await readDraft(local, 'one')).toBeUndefined();
	expect(await readDraft(local, 'two')).toBe('Retained draft');
});
